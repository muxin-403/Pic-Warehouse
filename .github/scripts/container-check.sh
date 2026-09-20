#!/usr/bin/env bash
# PicHost 容器级验证：把镜像在目标架构上真实跑起来，断言静态检查拿不到的不变式。
#
# 用法：
#   bash .github/scripts/container-check.sh <image:tag> <platform> <arch> <machine> <host-port> [--pull]
# 示例：
#   bash .github/scripts/container-check.sh ghcr.io/muxin-403/pic-warehouse:sha-abc1234 linux/arm64 arm64 aarch64 6893 --pull
#
# 为什么必须真跑起来：本项目依赖 sharp(libvips) 这个原生模块。镜像构建成功、清单里写了 arm64，
# 都不能证明 arm64 上的原生二进制真的能加载 —— 只有进程起来并完成一次真实编码才算数。
#
# 用 `bash 脚本` 显式调用（规避可执行位在 Windows 上易丢失的问题），不要依赖 ./script.sh。

set -uo pipefail   # 故意不加 -e：单个断言失败不应中断后面更关键的检查，最后统一汇总结论

IMAGE="${1:?用法: container-check.sh <image:tag> <platform> <arch> <machine> <host-port> [--pull]}"
PLATFORM="${2:?缺少参数 2: platform，如 linux/arm64}"
EXPECT_ARCH="${3:?缺少参数 3: OCI 架构，如 arm64}"
EXPECT_MACHINE="${4:?缺少参数 4: 容器内 uname -m 期望值，如 aarch64}"
HOST_PORT="${5:?缺少参数 5: 宿主机映射端口}"
PULL="${6:-}"

CONTAINER="ci-verify-${EXPECT_ARCH}"
FAILED=0

# 就绪等待节奏（可用环境变量覆盖；QEMU 下的 arm64 冷启动可能明显偏慢）
WAIT_ATTEMPTS="${WAIT_ATTEMPTS:-90}"
WAIT_INTERVAL="${WAIT_INTERVAL:-2}"
WAIT_BUDGET=$((WAIT_ATTEMPTS * WAIT_INTERVAL))

pass() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=$((FAILED + 1)); }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; }

# assert_eq <实际> <期望> <描述>
assert_eq() {
  if [ "$1" = "$2" ]; then
    pass "$3 = $1"
  else
    fail "$3：期望 [$2]，实际 [$1]"
  fi
}

# 容器内是否还在运行
running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" = "true" ]
}

cleanup() { docker rm -f "$CONTAINER" > /dev/null 2>&1 || true; }
trap cleanup EXIT

printf '\n===== 容器级验证 %s (%s) =====\n' "$IMAGE" "$PLATFORM"

if [ "$PULL" = "--pull" ]; then
  echo "-> 拉取 ${PLATFORM} 镜像"
  if ! docker pull --platform "$PLATFORM" "$IMAGE" > /dev/null; then
    fail "拉取镜像失败：$IMAGE"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 1) 镜像架构标记
#    注意：从 image inspect 取 .Architecture；容器 inspect 没有这个字段。
# ---------------------------------------------------------------------------
ACTUAL_ARCH="$(docker image inspect "$IMAGE" --format '{{.Architecture}}' 2>/dev/null || echo '')"
assert_eq "$ACTUAL_ARCH" "$EXPECT_ARCH" "镜像架构标记"

# ---------------------------------------------------------------------------
# 2) 启动容器（端口固定 6892，与 Dockerfile 的 EXPOSE / NITRO_PORT 一致）
# ---------------------------------------------------------------------------
docker rm -f "$CONTAINER" > /dev/null 2>&1 || true
echo "-> 启动容器：宿主 127.0.0.1:${HOST_PORT} -> 容器 6892"
if ! docker run -d --name "$CONTAINER" --platform "$PLATFORM" \
      -p "127.0.0.1:${HOST_PORT}:6892" "$IMAGE" > /dev/null; then
  fail "容器启动失败"
  docker logs "$CONTAINER" 2>&1 || true
  exit 1
fi

# ---------------------------------------------------------------------------
# 3) 等待 /api/health 就绪（循环重试，不要用固定 sleep）
#    这一条同时证明：Nitro 服务起来、启动插件跑通、存储后端与图片索引初始化没有抛错。
# ---------------------------------------------------------------------------
READY=0
for _ in $(seq 1 "$WAIT_ATTEMPTS"); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${HOST_PORT}/api/health" 2>/dev/null; then
    READY=1
    break
  fi
  # 容器已经死了就没必要继续等
  running || break
  sleep "$WAIT_INTERVAL"
done

if [ "$READY" = "1" ]; then
  BODY="$(curl -fsS "http://127.0.0.1:${HOST_PORT}/api/health" 2>/dev/null || echo '')"
  pass "服务就绪：GET /api/health -> ${BODY}"
else
  fail "${WAIT_BUDGET}s 内 /api/health 未就绪（容器未成功提供 HTTP 服务）"
  docker logs "$CONTAINER" 2>&1 || true
fi

if ! running; then
  warn "容器已退出，跳过依赖运行态的检查"
  docker logs "$CONTAINER" 2>&1 || true
else
  # -------------------------------------------------------------------------
  # 4) 容器内核实际运行的架构（平台选择错误的直接证据）
  # -------------------------------------------------------------------------
  MACHINE="$(docker exec "$CONTAINER" uname -m 2>/dev/null | tr -d '\r')"
  assert_eq "$MACHINE" "$EXPECT_MACHINE" "容器内 uname -m"

  # -------------------------------------------------------------------------
  # 5) sharp 原生模块在目标架构上真实可用
  #    这是本流水线最核心的一条：真正执行一次 WebP 编码。
  #    能跑通等价于 libvips 的 arm64/x64 预编译产物正确加载且可执行。
  # -------------------------------------------------------------------------
  SHARP_OUT="$(docker exec "$CONTAINER" node --input-type=module -e '
import { createRequire } from "node:module";
const require = createRequire("/app/package.json");
const sharp = require("sharp");
const buf = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 220, g: 40, b: 40 } } })
  .webp({ quality: 80 })
  .toBuffer();
if (!buf || buf.length === 0) throw new Error("WebP 输出为空");
if (buf.subarray(8, 12).toString("latin1") !== "WEBP") throw new Error("输出不是合法 WebP 容器");
console.log("libvips " + sharp.versions.vips + " / webp " + buf.length + "B");
' 2>&1)"
  SHARP_RC=$?
  if [ "$SHARP_RC" -eq 0 ]; then
    pass "sharp 原生模块可用（真实执行一次 WebP 编码）：${SHARP_OUT}"
  else
    fail "sharp 在 ${EXPECT_ARCH} 上不可用（预编译产物缺失或架构不匹配）：$(printf '%s' "$SHARP_OUT" | tr '\n' ' ')"
  fi

  # -------------------------------------------------------------------------
  # 6) 运行用户与 /data 写权限
  #    DATA_DIR=/data 且声明了 VOLUME /data，部署时会绑挂宿主目录 —— uid 不匹配是
  #    最常见的「容器能起、一上传就 500」事故，必须在 CI 里锁住。
  # -------------------------------------------------------------------------
  RUNTIME_USER="$(docker inspect -f '{{.Config.User}}' "$CONTAINER" 2>/dev/null || echo '')"
  if [ -z "$RUNTIME_USER" ]; then
    printf '  ..   运行用户：未显式声明 USER（即 root / uid 0）\n'
  else
    printf '  ..   运行用户：%s\n' "$RUNTIME_USER"
  fi

  docker exec "$CONTAINER" sh -c 'printf x > /data/.ci-write-probe && rm -f /data/.ci-write-probe' > /dev/null 2>&1
  assert_eq "$?" "0" "/data 对运行用户可写"

  # -------------------------------------------------------------------------
  # 7) 运维 CLI 是否真的被 COPY 进镜像（Dockerfile 的 COPY 契约，容易静默失效）
  # -------------------------------------------------------------------------
  MISSING_CLI=""
  for cli in reset-password slider clear-domains backup-cli-loader backup-export backup-restore storage-sync; do
    if ! docker exec -w /app "$CONTAINER" node --check "/app/server/cli/${cli}.mjs" > /dev/null 2>&1; then
      MISSING_CLI="${MISSING_CLI} ${cli}.mjs"
    fi
  done
  if [ -z "$MISSING_CLI" ]; then
    pass "镜像内 7 个运维 CLI 全部存在且语法可解析"
  else
    fail "镜像内缺少或无法解析的 CLI：${MISSING_CLI}"
  fi
fi

# ---------------------------------------------------------------------------
# 8) docker stop 是否优雅退出（信号转发正常，否则每次重启都要等超时强杀）
# ---------------------------------------------------------------------------
if running; then
  docker stop -t 20 "$CONTAINER" > /dev/null 2>&1
  STOP_RC=$?
  assert_eq "$STOP_RC" "0" "docker stop 优雅退出（ENTRYPOINT exec 到 node，信号可直达）"
else
  warn "容器已不在运行，跳过 docker stop 检查"
fi

# ---------------------------------------------------------------------------
# 9) ENTRYPOINT 子命令分发（诊断项，不计入失败）
#    docker-entrypoint.sh 用 `exec node <cli> "${@:2}"` 分发子命令，而基础镜像是
#    alpine 的 busybox sh，`${@:2}` 属 bash 扩展语法（依赖 ASH_BASH_COMPAT）。
#    这里只做观测与提示，不阻断流水线。
# ---------------------------------------------------------------------------
DISPATCH_OUT="$(docker run --rm --platform "$PLATFORM" "$IMAGE" reset-password 2>&1 || true)"
case "$DISPATCH_OUT" in
  *"no administrator account found"*)
    pass "ENTRYPOINT 子命令分发正常（reset-password 已在空数据卷上按预期报错退出）" ;;
  *"Bad substitution"*)
    warn 'ENTRYPOINT 分发失败：busybox sh 不支持 ${@:2}，需改成 POSIX 写法（见 docker-entrypoint.sh）' ;;
  *)
    warn "ENTRYPOINT 分发结果待人工确认：$(printf '%s' "$DISPATCH_OUT" | head -n 3 | tr '\n' ' ')" ;;
esac

# ---------------------------------------------------------------------------
printf '\n===== 结论：%s（失败 %s 项）=====\n\n' "$PLATFORM" "$FAILED"
[ "$FAILED" -eq 0 ]

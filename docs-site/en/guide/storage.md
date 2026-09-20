# Storage

Pic-Warehouse supports **local disk**, **S3-compatible object storage** (Cloudflare R2, Tencent COS, Alibaba OSS, AWS S3, etc.) and **WebDAV**. Admins manage backends at **Storage** (`/storage`); new uploads go to the **default** backend. The page shows a **storage overview** (total, used, remaining, usage rate, capacity chart) plus per-backend cards and supported backend types.

![Storage management](/screenshots/storage.png)

## Layout (local)

```
/data
├── pichost.db          # SQLite: users, sessions, settings, storage_backends, images index
└── images/             # All files when using local backend
```

- New uploads: `images/randomId.webp` or `images/YYYY/MM/randomId.webp` (flat mode in Settings)
- Migrated legacy: `images/blog/...` and similar
- With cloud backends, blobs live in the bucket; index stays in SQLite `images`

All **keys** start with `images/`. The upload API does **not** accept a `folder` parameter.

**Classification** uses per-user **tags** in SQLite (`tags` / `image_tags`); disk paths are unchanged. See [API](./api.md#6-tags).

## Adding a backend

1. Sign in as admin → **Storage** → **Add backend**.
2. Choose **local disk**, **S3-compatible** (R2 / COS / OSS presets) or **WebDAV**.
3. Enter connection details (bucket, endpoint, keys — or server URL, username, password).
4. **Set as default** so new uploads use it.

New object-storage backends get an auto-generated **storage ID** prefix: `local` for disk; `r2-*` for R2; `cos-*` for COS; `oss-*` for OSS; `s3-*` for AWS S3 and custom S3-compatible endpoints; `webdav-*` for WebDAV (immutable after creation; the image index references this ID).

### WebDAV

Pick the **WebDAV** preset and fill in four fields:

| Field | Notes |
| ----- | ----- |
| **Server URL** | WebDAV endpoint, may include a path prefix, e.g. `https://dav.example.com/remote.php/dav/files/user` |
| **Storage path** | Subfolder for images (e.g. `pichost`); leave empty to write to the server URL root. Missing folders are created automatically via `MKCOL` |
| **Username / Password** | Basic-auth credentials; leave empty for anonymous access. When editing, an empty password keeps the stored one |
| Serving mode | WebDAV rarely has its own CDN — keep **proxy** so Pic-Warehouse serves images from the same origin |

Objects are stored at `{server URL}/{storage path}/{image key}`, e.g. `https://dav.example.com/remote.php/dav/files/user/pichost/images/2026/09/xxx.webp`.

The driver uses standard WebDAV methods (`PUT` / `GET` / `HEAD` / `DELETE` / `MKCOL` / `PROPFIND`) with no third-party client library, and has been verified against Nextcloud, Koofr, Alist and `wsgidav`. **Test connection** validates auth, read and write access in one go.

### Cloudflare R2

| Field | Value |
| ----- | ----- |
| Endpoint | `https://<account_id>.r2.cloudflarestorage.com` |
| Region | `auto` |
| Bucket | Your R2 bucket name |
| Keys | R2 API token access / secret |

The **cloudflare** branch streamlines R2-only deploys; see branch notes on the [docs overview](./index.md).

### Environment variables (optional)

Some installs seed a default backend via environment variables:

**S3**: `STORAGE_BACKEND=s3`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`.

**WebDAV**: `STORAGE_BACKEND=webdav`, `WEBDAV_URL`, `WEBDAV_PATH`, `WEBDAV_USERNAME`, `WEBDAV_PASSWORD`, `WEBDAV_PUBLIC_URL`.

**UI-configured backends live in SQLite** alongside env-based defaults.

## URL modes

| Mode | Behavior |
| ---- | -------- |
| **proxy** | Serve via Pic-Warehouse (`GET /images/...`) |
| **public** | 302 redirect to bucket/CDN public URL |

Copied links use **IMAGE_BASE_URL**. “Hide folder prefix” may shorten URLs; the server resolves by path or basename.

## Usage & gallery filter

- Per-backend usage on the Storage page
- Gallery filters by **storage backend**, **upload source**, and **tags**; grid/list view toggle; click a thumbnail for the detail modal (dimensions, storage path, tags, link formats)

![Gallery grid](/screenshots/gallery.png) ![Gallery list](/screenshots/gallery-list.png) ![Image detail](/screenshots/gallery-detail.png)

## Backup & migration (v1.3.0+)

The **Backup & migration** panel has three action cards and a paginated **Recent jobs** table below:

| Feature | Description |
| ------- | ------------- |
| **Create site backup** | Export `.phost.tar.gz` with `pichost.db` and all images (including objects on cloud backends); shows estimated size and package contents |
| **Restore from backup** | Upload locally or pick an existing package under `data/backups/`, preview, then confirm; skip or overwrite conflicting images |
| **Cross-backend sync** | Copy images between configured backends and update the index; shows pending count/size, dry-run, optional delete-source and set-default |

![Backup & migration](/screenshots/storage.png)

- Exports are saved under `data/backups/`; only one backup/migration job may run at a time
- Job list supports pagination; download exports, view restore summaries, retry failed sync jobs
- Packages **do not** include cloud storage secrets — re-enter them on the Storage page after restore
- Uninitialized instances can use the **Restore backup** tab on `/setup` (always overwrite mode)

![Setup restore](/screenshots/setup-restore.png)

### CLI

```bash
docker exec pic-warehouse backup-export
docker exec pic-warehouse backup-restore /data/backups/pichost-xxx.phost.tar.gz
docker exec pic-warehouse backup-restore /data/backups/pichost-xxx.phost.tar.gz --overwrite
docker exec pic-warehouse storage-sync --from local --to s3-xxx --dry-run
docker exec pic-warehouse storage-sync --from local --to s3-xxx --set-default
```

Local development (project root):

```bash
npm run backup-export
npm run backup-restore -- data/backups/pichost-xxx.phost.tar.gz
npm run storage-sync -- --from local --to s3-xxx --dry-run
```

### Manual backup

You can still back up `data/images/`, `data/pichost.db`, and bucket objects directly; prefer the full-site export above.

## See also

- [Environment variables](./configuration.md)
- [Users & permissions](./users-and-permissions.md)

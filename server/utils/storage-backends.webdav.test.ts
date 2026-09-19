import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 覆盖老版本升级路径：历史库的 storage_backends 建表时
 * CHECK 约束只允许 ('local', 's3')，加入 webdav 需要重建该表。
 */

const dataDir = mkdtempSync(join(tmpdir(), 'pichost-webdav-migrate-'))

describe('storage_backends 类型约束迁移', () => {
  beforeAll(() => {
    process.env.DATA_DIR = dataDir

    const db = new DatabaseSync(join(dataDir, 'pichost.db'))
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE storage_backends (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('local', 's3')),
        config_json TEXT NOT NULL DEFAULT '{}',
        secret_json TEXT NOT NULL DEFAULT '{}',
        serving_mode TEXT NOT NULL DEFAULT 'proxy' CHECK(serving_mode IN ('proxy', 'public')),
        public_url TEXT NOT NULL DEFAULT '',
        quota_bytes INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE images (
        key TEXT PRIMARY KEY,
        backend_id TEXT NOT NULL,
        user_id INTEGER,
        folder TEXT NOT NULL,
        original_name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        uploaded_at TEXT NOT NULL,
        FOREIGN KEY (backend_id) REFERENCES storage_backends(id)
      );
      INSERT INTO storage_backends
        (id, name, type, config_json, secret_json, serving_mode, public_url,
         quota_bytes, enabled, is_default, sort_order)
      VALUES
        ('local', '本地磁盘', 'local', '{}', '{}', 'proxy', '', NULL, 1, 1, 0),
        ('s3-old', '老 S3 后端', 's3', '{"endpoint":"https://s3.example.com","region":"auto","bucket":"pics"}', '{"accessKeyId":"ak","secretAccessKey":"sk"}', 'proxy', 'https://cdn.example.com', 1024, 1, 0, 1);
    `)
    db.close()
  })

  afterAll(async () => {
    const { closeDb } = await import('./db')
    closeDb()
    delete process.env.DATA_DIR
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('重建表后可写入 webdav 且保留原有后端数据', async () => {
    const mod = await import('./storage-backends')
    mod.ensureDefaultBackends()

    const id = mod.insertWebdavStorageBackend({
      name: '测试 WebDAV',
      config: { baseUrl: 'https://dav.example.com', path: 'pichost' },
      secrets: { username: 'alice', password: 'secret' },
      quotaBytes: 2048
    })

    expect(id).toMatch(/^webdav-[0-9a-f]{8}$/)

    const row = mod.getStorageBackendRow(id)
    expect(row?.type).toBe('webdav')
    expect(JSON.parse(row!.config_json)).toEqual({
      baseUrl: 'https://dav.example.com',
      path: 'pichost'
    })
    expect(JSON.parse(row!.secret_json)).toEqual({
      username: 'alice',
      password: 'secret'
    })

    // 迁移不得丢失原有后端
    const local = mod.getStorageBackendRow('local')
    expect(local?.name).toBe('本地磁盘')
    expect(local?.is_default).toBe(1)

    const legacy = mod.getStorageBackendRow('s3-old')
    expect(legacy?.type).toBe('s3')
    expect(JSON.parse(legacy!.config_json).bucket).toBe('pics')
    expect(legacy?.public_url).toBe('https://cdn.example.com')
  })

  it('列表接口对 WebDAV 掩码密码但保留用户名', async () => {
    const mod = await import('./storage-backends')
    const id = mod.insertWebdavStorageBackend({
      name: '掩码检查',
      config: { baseUrl: 'https://dav.example.com', path: 'pichost' },
      secrets: { username: 'bob', password: 'topsecret' }
    })

    const info = mod.listStorageBackends().find(item => item.id === id)
    expect(info?.type).toBe('webdav')
    expect(info?.secretsMasked.username).toBe('bob')
    expect(info?.secretsMasked.password).not.toBe('topsecret')
    expect(info?.secretsMasked.password).toContain('*')
    expect(info?.config).toEqual({ baseUrl: 'https://dav.example.com', path: 'pichost' })
  })

  it('更新 WebDAV 配置时密码留空保持原值', async () => {
    const mod = await import('./storage-backends')
    const id = mod.insertWebdavStorageBackend({
      name: '更新前',
      config: { baseUrl: 'https://dav.example.com', path: 'pichost' },
      secrets: { username: 'carol', password: 'origin' }
    })

    mod.updateStorageBackend(id, {
      name: '更新后',
      config: { baseUrl: 'https://dav2.example.com', path: 'other' },
      secrets: { username: 'carol2', password: '' }
    })

    const row = mod.getStorageBackendRow(id)!
    expect(row.name).toBe('更新后')
    expect(JSON.parse(row.config_json)).toEqual({
      baseUrl: 'https://dav2.example.com',
      path: 'other'
    })
    expect(JSON.parse(row.secret_json)).toEqual({
      username: 'carol2',
      password: 'origin'
    })
  })
})

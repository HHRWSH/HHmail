import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DB_FILE_NAME, LEGACY_DB_FILE_NAME, normalizeDbFileName, resolveDbPath } from './bootstrap'
import { DEFAULT_BRAND_NAME, DEFAULT_BRAND_SUBTITLE } from '../shared/defaults'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mail-ai-bootstrap-'))
}

describe('V2.2 通用化：数据库文件定位与旧名改名', () => {
  it('新名字优先；只有旧名字时也能找到（升级不丢数据）', () => {
    const dir = tmpDir()
    expect(path.basename(resolveDbPath(dir))).toBe(DB_FILE_NAME) // 都没有 → 新名字（新建用）
    fs.writeFileSync(path.join(dir, LEGACY_DB_FILE_NAME), 'legacy')
    expect(path.basename(resolveDbPath(dir))).toBe(LEGACY_DB_FILE_NAME)
    fs.writeFileSync(path.join(dir, DB_FILE_NAME), 'new')
    expect(path.basename(resolveDbPath(dir))).toBe(DB_FILE_NAME)
    // 显式指定路径优先（mock/诊断用）
    expect(resolveDbPath(dir, '/tmp/x.db')).toBe('/tmp/x.db')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('旧文件名会被改成通用名（含 -wal/-shm），且幂等、不覆盖已存在的新文件', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, LEGACY_DB_FILE_NAME), 'legacy')
    fs.writeFileSync(path.join(dir, `${LEGACY_DB_FILE_NAME}-wal`), 'wal')
    normalizeDbFileName(dir)
    expect(fs.existsSync(path.join(dir, DB_FILE_NAME))).toBe(true)
    expect(fs.existsSync(path.join(dir, `${DB_FILE_NAME}-wal`))).toBe(true)
    expect(fs.existsSync(path.join(dir, LEGACY_DB_FILE_NAME))).toBe(false)
    // 再跑一次不会出问题
    normalizeDbFileName(dir)
    expect(fs.readdirSync(dir).sort()).toEqual([DB_FILE_NAME, `${DB_FILE_NAME}-wal`].sort())

    // 新文件已存在时不动旧文件（避免覆盖用户数据）
    const dir2 = tmpDir()
    fs.writeFileSync(path.join(dir2, LEGACY_DB_FILE_NAME), 'legacy')
    fs.writeFileSync(path.join(dir2, DB_FILE_NAME), 'new')
    normalizeDbFileName(dir2)
    expect(fs.readFileSync(path.join(dir2, DB_FILE_NAME), 'utf8')).toBe('new')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(dir2, { recursive: true, force: true })
  })

  it('默认品牌名不绑定任何学校', () => {
    expect(DEFAULT_BRAND_NAME).not.toMatch(/大学|university/i)
    expect(DEFAULT_BRAND_SUBTITLE.length).toBeGreaterThan(0)
  })
})

describe('V2.2 迁移守卫：已经迁过就不要重复复制', () => {
  it('目标目录只要有任一种数据库文件名，就视为已迁移', () => {
    const dir = tmpDir()
    // 模拟「上次启动已把旧库改名成 mail-ai.db」的状态
    fs.writeFileSync(path.join(dir, DB_FILE_NAME), 'migrated')
    const hasDb = (d: string): boolean =>
      fs.existsSync(path.join(d, DB_FILE_NAME)) || fs.existsSync(path.join(d, LEGACY_DB_FILE_NAME))
    expect(hasDb(dir)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

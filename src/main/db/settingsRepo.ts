/**
 * app_settings 表仓储（SQLite 实现，注入 SafeStorageSettingsStore）。
 */
import Database from 'better-sqlite3'
import { migrate } from './schema'
import type { SettingsRepository } from '../settings'

export class SqliteSettingsRepository implements SettingsRepository {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    migrate(this.db)
  }

  async getRaw(key: string): Promise<{ value_enc: string } | null> {
    const row = this.db.prepare('SELECT value_enc FROM app_settings WHERE key = ?').get(key) as
      | { value_enc: Buffer }
      | undefined
    if (!row) return null
    return { value_enc: row.value_enc.toString('base64') }
  }

  async setRaw(key: string, valueEnc: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value_enc, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_enc=excluded.value_enc, updated_at=excluded.updated_at`
      )
      .run(key, Buffer.from(valueEnc, 'base64'), Date.now())
  }

  async deleteRaw(key: string): Promise<void> {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }
}

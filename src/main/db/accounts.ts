/**
 * accounts 表仓储（SQLite 实现，注入 SafeStorageTokenStore）。
 */
import Database from 'better-sqlite3'
import { migrate } from './schema'
import type { AccountRecord, AccountRepository } from '../auth/tokenStore'

export class SqliteAccountRepository implements AccountRepository {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    migrate(this.db)
  }

  async getAccount(): Promise<AccountRecord | null> {
    const row = this.db
      .prepare(
        'SELECT email, refresh_token_enc, access_token_enc, access_token_expires_at FROM accounts ORDER BY id DESC LIMIT 1'
      )
      .get() as { email: string; refresh_token_enc: Buffer; access_token_enc: Buffer | null; access_token_expires_at: number | null } | undefined
    if (!row || !row.access_token_enc) return null
    return {
      email: row.email,
      refreshTokenEnc: row.refresh_token_enc.toString('base64'),
      accessTokenEnc: row.access_token_enc.toString('base64'),
      accessTokenExpiresAtMs: row.access_token_expires_at ?? 0
    }
  }

  async upsertAccount(record: AccountRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO accounts (email, refresh_token_enc, access_token_enc, access_token_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           refresh_token_enc=excluded.refresh_token_enc,
           access_token_enc=excluded.access_token_enc,
           access_token_expires_at=excluded.access_token_expires_at`
      )
      .run(
        record.email,
        Buffer.from(record.refreshTokenEnc, 'base64'),
        Buffer.from(record.accessTokenEnc, 'base64'),
        record.accessTokenExpiresAtMs,
        Date.now()
      )
  }

  async clearAccount(): Promise<void> {
    this.db.prepare('DELETE FROM accounts').run()
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 硬约束守护测试（规范 §2 / §14.8 第 1 条）：
 * - IMAP 实现里不允许出现写命令 STORE/COPY/MOVE/DELETE；
 * - readonly + BODY.PEEK（imapflow 的 source 下载）；
 * - 上层模块禁止 import imapflow / better-sqlite3 / openai；
 * - 弃用模型名不得出现在代码常量中。
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(__dirname, '..', '..')
function readRel(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

describe('只读三连（规范 §2 第 1 条）', () => {
  it('imap.ts 不包含 STORE/COPY/MOVE/DELETE 写命令', () => {
    const src = readRel('src/main/mail/imap.ts')
    for (const cmd of ['"STORE"', "'STORE'", '"COPY"', "'COPY'", '"MOVE"', "'MOVE'", '"DELETE"', "'DELETE'"]) {
      expect(src).not.toContain(cmd)
    }
  })

  it('INBOX/任意文件夹永远 readOnly: true（V2 M3 泛化到 openFolder）', () => {
    const src = readRel('src/main/mail/imap.ts')
    expect(src).toContain("mailboxOpen(folderPath, { readOnly: true })")
    expect(src).not.toMatch(/mailboxOpen\([^)]*readOnly\s*:\s*false/)
  })

  it('取正文用 source 下载（imapflow 内部 BODY.PEEK[]），无裸 FETCH', () => {
    const src = readRel('src/main/mail/imap.ts')
    expect(src).toContain('source: true')
  })
})

describe('依赖倒置（规范 §14.8 第 1 条：上层不 import 具体实现）', () => {
  const FORBIDDEN = {
    'src/main/mail/sync.ts': ['imapflow', 'better-sqlite3', 'openai'],
    'src/main/mail/thread.ts': ['imapflow', 'better-sqlite3', 'openai'],
    'src/main/db/search.ts': ['better-sqlite3', 'imapflow'],
    'src/main/ai/service.ts': ['openai', 'imapflow', 'better-sqlite3'],
    'src/shared/ipc-contract.ts': ['electron', 'better-sqlite3'],
    'src/preload/index.ts': ['zod', 'better-sqlite3']
  }
  for (const [file, banned] of Object.entries(FORBIDDEN)) {
    it(`${file} 不 import 禁用库`, () => {
      const src = readRel(file)
      for (const lib of banned) {
        expect(src).not.toMatch(new RegExp(`from ['"]${lib}`))
      }
    })
  }

  it('UI / IPC 契约不含 imapflow/better-sqlite3/openai', () => {
    for (const file of ['src/renderer/src/App.tsx', 'src/renderer/src/pages/Inbox.tsx', 'src/shared/types.ts']) {
      const src = readRel(file)
      expect(src).not.toMatch(/imapflow|better-sqlite3|openai/)
    }
  })
})

describe('模型名弃用（规范 §3.1）', () => {
  it('业务/UI 代码中不得把弃用模型名作为运行时模型（config 中仅用于拒绝逻辑）', () => {
    for (const file of ['src/main/ai/deepseek.ts', 'src/renderer/src/mockBridge.ts']) {
      const src = readRel(file)
      expect(src).not.toContain('deepseek-chat')
      expect(src).not.toContain('deepseek-reasoner')
    }
  })

  it('config.ts 将弃用模型名列入拒绝名单', () => {
    const src = readRel('src/main/config.ts')
    expect(src).toContain('DEPRECATED_AI_MODELS')
  })
})

describe('Electron 安全基线（规范 §2 第 9 条）', () => {
  it('窗口配置 contextIsolation/nodeIntegration/sandbox 三连', () => {
    const src = readRel('src/main/index.ts')
    expect(src).toContain('contextIsolation: true')
    expect(src).toContain('nodeIntegration: false')
    expect(src).toContain('sandbox: true')
    expect(src).toContain('webviewTag: false')
  })

  it('设备码 scope 常量只有 IMAP 只读 scope（规范 §2 第 3 条）', () => {
    const src = readRel('src/main/config.ts')
    expect(src).toContain("'https://outlook.office.com/IMAP.AccessAsUser.All'")
  })
})

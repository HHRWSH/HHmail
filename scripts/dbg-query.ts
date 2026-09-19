/**
 * 检索调试脚本（开发用，不参与打包）：把「某几个问题」的候选与得分打到 tests/eval/dbg.md。
 *
 * 为什么要它：评测只告诉我们"第一封对不对"，不告诉我们**为什么**。
 * 这里额外打印每个候选命中了哪些检索词、命中在主题还是卡片，便于定位排序问题。
 *
 * 用法（better-sqlite3 需为 Electron ABI，先 npm run rebuild:electron）：
 *   npm run build:eval && node scripts/run-eval.mjs --dbg
 * 报告：tests/eval/dbg.md（含主题与卡片片段，属隐私文件，已在 .gitignore 中）
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import { SqliteMessageStore } from '../src/main/db/sqlite'
import { MemoryLogger } from '../src/main/logger'
import { collectAskContext } from '../src/main/ai/service'
import { buildRetrievalQuery } from '../src/shared/retrievalQuery'
import { scoreFields } from '../src/shared/retrievalRank'
import { parseQueryIntent } from '../src/shared/indexCard'

app.disableHardwareAcceleration()

/** 各题的期望邮件 id（与 tests/eval/questions.json 保持一致，便于对照） */
const EXPECT: Record<string, number[]> = {
  'Blackboard 上有什么新通知？': [92, 130, 131, 107, 137, 140],
  '实习或就业相关的邮件？': [178, 180, 176, 159, 150, 167],
  '语言课程或英语工作坊？': [168, 182, 166, 153],
  '图书馆相关的邮件有哪些？': [55],
  '学费什么时候交？': [115]
}

const QUESTIONS = [
  'Blackboard 上有什么新通知？',
  '实习或就业相关的邮件？',
  '语言课程或英语工作坊？',
  '图书馆相关的邮件有哪些？',
  '学费什么时候交？'
]

function copyDb(src: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hhmail-dbg-'))
  const dst = path.join(dir, 'dbg.db')
  fs.copyFileSync(src, dst)
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${src}${suffix}`)) fs.copyFileSync(`${src}${suffix}`, `${dst}${suffix}`)
  }
  return dst
}

app.whenReady().then(async () => {
  const root = process.cwd()
  const appData = app.getPath('appData')
  const liveDir = fs.existsSync(path.join(appData, 'mail-ai')) ? path.join(appData, 'mail-ai') : path.join(appData, 'cuhk-mail-ai')
  const liveDb = fs.existsSync(path.join(liveDir, 'mail-ai.db'))
    ? path.join(liveDir, 'mail-ai.db')
    : path.join(liveDir, 'cuhk-mail.db')
  const tmpDb = copyDb(liveDb)
  const store = new SqliteMessageStore(tmpDb, new MemoryLogger())
  const lines: string[] = ['# 检索调试（dbg）', '']

  for (const q of QUESTIONS) {
    const intent = parseQueryIntent(q)
    const rq = buildRetrievalQuery(q, intent.keywords)
    lines.push(`## ${q}`)
    lines.push(`- keywords: \`${intent.keywords}\`｜filter: \`${JSON.stringify(intent.filter)}\`｜hasContent: ${rq.hasContent}`)
    lines.push(`- exact/variant: ${rq.terms.filter((t) => t.kind !== 'window').map((t) => `${t.term}(${t.weight})`).join(' ')}`)
    const ctx = await collectAskContext(store, q, 5, new MemoryLogger())
    const idxHits = ctx.indexDocs.map((d) => ({ ...d, body: d.card }))
    const ranked = idxHits.map((h) => ({ h, score: scoreFields(h, rq.terms) }))
    lines.push(`- indexDocs: ${ctx.indexDocs.length}｜summary: ${ctx.summaries.length}｜mails: ${ctx.mails.length}｜recent: ${ctx.usedRecentFallback}`)
    lines.push('')
    lines.push('| # | 来源 | 得分 | 主题 | 命中的词（主题/卡片） |')
    lines.push('| --- | --- | --- | --- | --- |')
    ranked.slice(0, 15).forEach(({ h, score }, i) => {
      const subjHit: string[] = []
      const cardHit: string[] = []
      for (const t of rq.terms) {
        if (h.subject.toLowerCase().includes(t.term.toLowerCase())) subjHit.push(t.term)
        else if (h.card.toLowerCase().includes(t.term.toLowerCase())) cardHit.push(t.term)
      }
      lines.push(
        `| ${i + 1} | ${h.via} | ${score.toFixed(1)} | ${h.subject.replace(/\|/g, '/').slice(0, 60)} | 主题: ${subjHit.slice(0, 8).join(',') || '-'} / 卡片: ${cardHit.slice(0, 12).join(',') || '-'} |`
      )
    })
    lines.push('')
    lines.push('<details><summary>卡片刻意（前 12 条 + 期望邮件）</summary>')
    lines.push('')
    const wantIds = (EXPECT[q] ?? []).map((id) => idxHits.find((h) => h.id === id)).filter(Boolean) as typeof idxHits
    for (const h of [...idxHits.slice(0, 12), ...wantIds]) {
      lines.push(`**#${h.id} (${h.via}) ${h.subject}**`)
      lines.push('')
      lines.push('```')
      lines.push(h.card.slice(0, 700))
      lines.push('```')
      lines.push('')
    }
    lines.push('</details>')
    lines.push('')
  }

  const out = path.join(root, 'tests', 'eval', 'dbg.md')
  fs.writeFileSync(out, lines.join('\n'), 'utf8')
  console.log(`调试报告已写入 ${out}`)
  store.close()
  try {
    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  app.exit(0)
})

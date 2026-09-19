/**
 * 检索评测 CLI（M1）。
 *
 * 为什么用 Electron 跑：better-sqlite3 是原生模块，日常开发时它被编译成 Electron ABI；
 * 用 Electron 的 node 模式执行可以避免来回 rebuild。
 *
 * 安全：**不直接打开线上库**，而是先复制一份到临时目录再打开（只读评测，绝不动线上数据）。
 * 隐私：只打印邮件 id 与主题（主题用于让你判断召回对不对），不打印正文。
 *
 * 用法：
 *   npm run eval:retrieval              # 全部问题
 *   npm run eval:retrieval -- --topk 8  # 自定义 topK
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import { SqliteMessageStore } from '../src/main/db/sqlite'
import { MemoryLogger } from '../src/main/logger'
import { collectAskContext } from '../src/main/ai/service'
import { formatEvalReport, runRetrievalEval, type EvalQuestion } from '../src/main/eval/retrievalEval'

app.disableHardwareAcceleration()

function argValue(name: string, fallback: number): number {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx < 0) return fallback
  const n = Number.parseInt(process.argv[idx + 1] ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function copyDb(src: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hhmail-eval-'))
  const dst = path.join(dir, 'eval.db')
  fs.copyFileSync(src, dst)
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${src}${suffix}`)) fs.copyFileSync(`${src}${suffix}`, `${dst}${suffix}`)
  }
  return dst
}

app.whenReady().then(async () => {
  const root = process.cwd()
  const questionsPath = path.join(root, 'tests', 'eval', 'questions.json')
  const reportPath = path.join(root, 'tests', 'eval', 'report.md')
  try {
    if (!fs.existsSync(questionsPath)) {
      console.error(`❌ 找不到问题文件：${questionsPath}`)
      app.exit(1)
      return
    }
    const questions = JSON.parse(fs.readFileSync(questionsPath, 'utf8')) as EvalQuestion[]
    const appData = app.getPath('appData')
  const liveDir = fs.existsSync(path.join(appData, 'mail-ai')) ? path.join(appData, 'mail-ai') : path.join(appData, 'cuhk-mail-ai')
  const liveDb = fs.existsSync(path.join(liveDir, 'mail-ai.db'))
    ? path.join(liveDir, 'mail-ai.db')
    : path.join(liveDir, 'cuhk-mail.db')
    if (!fs.existsSync(liveDb)) {
      console.error(`❌ 找不到邮件库：${liveDb}（先启动一次应用完成同步）`)
      app.exit(1)
      return
    }
    const tmpDb = copyDb(liveDb)
    const logger = new MemoryLogger()
    const store = new SqliteMessageStore(tmpDb, logger)
    const version = (store as unknown as { db: Database.Database }).db.pragma('user_version', { simple: true })
    const total = await store.count()
    const missing = await store.countMissingIndexDocs()
    console.log(`库版本 v${version}｜邮件 ${total} 封｜缺索引卡片 ${missing} 封`)
    console.log(`问题 ${questions.length} 个｜topK=${argValue('topk', 5)}`)

    // --suggest：标注辅助模式。除了线上链路的命中，再额外列出「只被摘要/正文命中」的候选，
    // 避免标注时只看到现有检索结果（否则评测是循环论证：漏召回的邮件永远进不了标准答案）。
    if (process.argv.includes('--suggest')) {
      const lines: string[] = ['# 标注候选（--suggest）', '']
      for (const item of questions) {
        lines.push(`## ${item.q}`)
        if (item.expect && item.expect.length > 0) lines.push(`- 已标注期望：${item.expect.join(', ')}`)
        const topK = 8
        const ctx = await collectAskContext(store, item.q, topK, logger)
        const shown = new Set<number>()
        lines.push('')
        lines.push('**线上检索链路实际用到的（按顺序）**')
        for (const d of ctx.indexDocs) {
          if (shown.has(d.id)) continue
          shown.add(d.id)
          lines.push(`- [索引/${d.via}] #${d.id} ${d.subject}${d.dueTs ? `（截止 ${new Date(d.dueTs).toLocaleString('zh-CN', { hour12: false })}）` : ''}`)
        }
        for (const s2 of ctx.summaries) {
          if (shown.has(s2.id)) continue
          shown.add(s2.id)
          lines.push(`- [摘要] #${s2.id} ${s2.subject}`)
        }
        for (const m of ctx.mails) {
          if (shown.has(m.id)) continue
          shown.add(m.id)
          lines.push(`- [${ctx.usedRecentFallback ? '最近兜底' : '正文'}] #${m.id} ${m.subject}`)
        }
        lines.push('')
        lines.push('**额外候选（放宽检索，供标注参考）**')
        const extra: Array<{ id: number; subject: string; src: string }> = []
        for (const h of await store.searchSummaries(item.q, 30)) {
          if (!shown.has(h.id)) extra.push({ id: h.id, subject: h.subject, src: '摘要' })
        }
        for (const h of await store.search(item.q, 30, { retrieval: true })) {
          if (!shown.has(h.id) && !extra.some((e) => e.id === h.id)) extra.push({ id: h.id, subject: h.subject, src: '正文' })
        }
        for (const e of extra.slice(0, 12)) lines.push(`- [${e.src}] #${e.id} ${e.subject}`)
        lines.push('')
      }
      const out = path.join(root, 'tests', 'eval', 'suggest.md')
      fs.writeFileSync(out, lines.join('\n'), 'utf8')
      console.log(`标注候选已写入 ${out}`)
      store.close()
      app.exit(0)
      return
    }

    const report = await runRetrievalEval(store, questions, { topK: argValue('topk', 5) })
    const text = formatEvalReport(report, new Date().toLocaleString('zh-CN', { hour12: false }))
    fs.writeFileSync(reportPath, text, 'utf8')
    console.log('')
    console.log(
      `Recall@1 = ${(report.recallAt1 * 100).toFixed(1)}%　Recall@5 = ${(report.recallAt5 * 100).toFixed(1)}%（命中任一即算对的 ${report.scored} 题）`
    )
    console.log(`集合题覆盖率 = ${(report.coverage * 100).toFixed(1)}%（${report.setQuestions} 题，按 |召回∩期望|/|期望| 计算）`)
    console.log('命中来源：', JSON.stringify(report.sourceStats))
    for (const row of report.rows) {
      const mark =
        row.expect.length === 0
          ? '·'
          : row.expectAll
            ? `集合 ${(row.coverage * 100).toFixed(0)}%`
            : row.recallAt1
              ? '✅'
              : row.recallAt5
                ? '🟡'
                : '❌'
      console.log(`${mark} ${row.q}`)
      if (row.expect.length === 0) {
        for (const h of row.hits.slice(0, 3)) console.log(`    · [${h.source}] #${h.id} ${h.subject}`)
      }
    }
    console.log('')
    console.log(`报告已写入 ${reportPath}`)
    store.close()
    try {
      fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败无所谓 */
    }
    app.exit(0)
  } catch (e) {
    console.error('评测失败：', e instanceof Error ? e.message : String(e))
    app.exit(1)
  }
})

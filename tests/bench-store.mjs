/**
 * 主进程侧性能基准：用「真实数据库的副本」量 INBOX 切页要走的那些查询。
 * 用法：node bench-store.mjs <dbPath>
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'

const dbPath = process.argv[2]
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error('用法：node bench-store.mjs <mail-ai.db>')
  process.exit(1)
}
const db = new Database(dbPath, { readonly: true })
const time = (label, fn, runs = 5) => {
  const arr = []
  let out
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now()
    out = fn()
    arr.push(performance.now() - t0)
  }
  arr.sort((a, b) => a - b)
  return { label, medianMs: Number(arr[Math.floor(arr.length / 2)].toFixed(1)), maxMs: Number(arr[arr.length - 1].toFixed(1)), size: out }
}

const rows = db.prepare('SELECT COUNT(*) AS n FROM messages').get()
const tagRows = db.prepare('SELECT COUNT(*) AS n FROM mail_tags').get()
const labelRows = db.prepare('SELECT COUNT(*) AS n FROM message_labels').get()
const sumRows = db.prepare('SELECT COUNT(*) AS n FROM mail_summaries').get()
const docRows = db.prepare('SELECT COUNT(*) AS n FROM mail_index_docs').get()

// 旧实现（SELECT m.*）：会把 body_html/body_text 整份读出来
const listOldStmt = db.prepare(`
  SELECT m.*,
    (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS has_attachments,
    (SELECT snooze_until FROM snoozes s WHERE s.message_id = m.id AND s.notified_at IS NULL) AS snooze_until
  FROM messages m WHERE m.folder = 'INBOX' ORDER BY m.date_ts DESC, m.uid DESC LIMIT ?
`)
// 新实现（只取列表需要的列）
const listStmt = db.prepare(`
  SELECT m.id, m.uid, m.thread_id, m.subject, m.from_name, m.from_addr, m.date_ts, m.snippet,
         m.is_read, m.starred, m.folder,
    (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS has_attachments,
    (SELECT snooze_until FROM snoozes s WHERE s.message_id = m.id AND s.notified_at IS NULL) AS snooze_until
  FROM messages m WHERE m.folder = 'INBOX' ORDER BY m.date_ts DESC, m.uid DESC LIMIT ?
`)
const idsOf = (limit) => listStmt.all(limit).map((r) => r.id)

const results = []
results.push(time('【旧】列表 200 封（SELECT m.*，含 body_html）', () => listOldStmt.all(200).length))
results.push(time('【新】列表 200 封（只取列表列）', () => listStmt.all(200).length, 20))
results.push(time('【旧】列表 200 封 序列化字节数', () => JSON.stringify(listOldStmt.all(200)).length))
results.push(time('【新】列表 200 封 序列化字节数', () => JSON.stringify(listStmt.all(200)).length))
results.push(time('标签回填（200 封 id IN）', () => {
  const ids = idsOf(200)
  const ph = ids.map(() => '?').join(',')
  return db.prepare(`SELECT message_id, tag, source FROM mail_tags WHERE message_id IN (${ph})`).all(...ids).length
}))
results.push(time('旧标签回填（200 封 id IN，JOIN labels）', () => {
  const ids = idsOf(200)
  const ph = ids.map(() => '?').join(',')
  return db
    .prepare(
      `SELECT ml.message_id, l.id, l.name, l.color FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id IN (${ph})`
    )
    .all(...ids).length
}))
results.push(time('摘要回填（200 封，含正文摘要文本）', () => {
  const ids = idsOf(200)
  const ph = ids.map(() => '?').join(',')
  return db.prepare(`SELECT message_id, summary_text FROM mail_summaries WHERE message_id IN (${ph})`).all(...ids).length
}))
results.push(time('索引卡片读取（200 封）', () => {
  const ids = idsOf(200)
  const ph = ids.map(() => '?').join(',')
  return db.prepare(`SELECT message_id, card FROM mail_index_docs WHERE message_id IN (${ph})`).all(...ids).length
}))
results.push(time('标签统计（全库 GROUP BY）', () => db.prepare('SELECT tag, COUNT(DISTINCT message_id) n FROM mail_tags GROUP BY tag ORDER BY n DESC LIMIT 200').all().length))
results.push(time('未生成摘要计数', () => db.prepare('SELECT COUNT(*) n FROM messages m LEFT JOIN mail_summaries s ON s.message_id = m.id WHERE s.message_id IS NULL').get().n))
// 序列化成本：把 200 行变成 IPC 传输的 JSON
results.push(time('200 封 JSON 序列化（IPC 传输成本）', () => JSON.stringify(listStmt.all(200)).length))
results.push(time('详情：单封正文读取（body_text+body_html）', () =>
  db.prepare('SELECT length(body_text) a, length(body_html) b FROM messages ORDER BY date_ts DESC LIMIT 1').get()
))
results.push(time('FTS 检索一次（trigram）', () =>
  db.prepare("SELECT COUNT(*) n FROM messages_fts WHERE messages_fts MATCH ?").get('"奖学金"').n
))

console.log(
  JSON.stringify(
    {
      db: dbPath,
      messages: rows.n,
      mailTags: tagRows.n,
      messageLabels: labelRows.n,
      summaries: sumRows.n,
      indexDocs: docRows.n,
      results
    },
    null,
    2
  )
)
db.close()

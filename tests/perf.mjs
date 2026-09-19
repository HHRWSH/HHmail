/**
 * 性能自测（贴近真机）：模拟「邮件很多 + 正在同步 + 连推新邮件」时切到收件箱的卡顿。
 *
 * 用法：node perf.mjs [count] [--burst]
 *   count  邮件数量（默认 3000）
 *   --burst 额外注入：① 每 150ms 一条 sync 进度事件（持续 6s）② 每 120ms 一条新邮件事件（持续 4s）
 *           这两件事在真机上就是「进 INBOX 触发同步」的表现，也是用户感觉卡顿时的上下文。
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const COUNT = Number.parseInt(args.find((a) => /^\d+$/.test(a)) ?? '3000', 10)
const BURST = args.includes('--burst')
const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'out', 'renderer')
const OUT = path.join(ROOT, 'tests-tmp')
fs.mkdirSync(OUT, { recursive: true })

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\//, '') || 'index.html'
  fs.readFile(path.join(DIST, rel), (err, data) => {
    if (err) { res.writeHead(404); res.end('nf'); return }
    res.writeHead(200, { 'content-type': MIME[path.extname(rel)] || 'application/octet-stream' })
    res.end(data)
  })
})
await new Promise((r) => server.listen(8149, '127.0.0.1', r))

const candidates = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
const executablePath = candidates.find((p) => fs.existsSync(p))
const browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })

await page.addInitScript(() => {
  window.__longTasks = []
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push(Math.round(e.duration)) }).observe({ entryTypes: ['longtask'] })
  } catch { /* ignore */ }
})

await page.goto(`http://127.0.0.1:8149/index.html?count=${COUNT}`, { waitUntil: 'load' })
await page.waitForTimeout(400)
const t0 = Date.now()
await page.click('button:has-text("开始登录")')
await page.waitForSelector('.mail-list .mail-item', { timeout: 60000 })
const firstPaintMs = Date.now() - t0
await page.waitForTimeout(1200)

// 让渲染的行数接近真机（用户点了「加载更多」/条数设置较大）
for (let i = 0; i < 6; i += 1) {
  await page.click('[data-testid="load-more"]').catch(() => {})
  await page.waitForTimeout(150)
}
const domRows = await page.evaluate(() => document.querySelectorAll('.mail-item').length)

const measure = async (label, fn) => {
  await page.evaluate(() => { window.__longTasks = [] })
  const start = Date.now()
  await fn()
  const ms = Date.now() - start
  const long = await page.evaluate(() => (window.__longTasks || []).slice())
  return { label, ms, longMax: long.length ? Math.max(...long) : 0, longCount: long.length }
}

const results = []

if (BURST) {
  // 注入事件风暴（模拟同步）：进度事件 + 新邮件事件
  await page.evaluate(() => {
    window.__burst = { progress: 0, newMail: 0 }
    // 直接触发渲染层订阅的回调：mock 桥把监听器挂在 window 上（见 bridge 的 mockBridge 实现）
    const fire = (kind, payload) => {
      const set = window.__mockListeners?.[kind]
      if (set) for (const cb of set) cb(payload)
    }
    window.__fireProgress = () => {
      window.__burst.progress += 1
      fire('sync', { phase: 'incremental', done: window.__burst.progress, total: 200 })
    }
    window.__fireNewMail = (i) => {
      window.__burst.newMail += 1
      fire('newMail', { id: 100 + i, subject: `注入的新邮件 ${i}`, summary: true })
    }
  })
  const hasListeners = await page.evaluate(() => Boolean(window.__mockListeners))
  if (!hasListeners) {
    results.push({ label: '⚠️ 无法注入事件（mock 监听器未暴露）', ms: 0, longMax: 0, longCount: 0 })
  }
  results.push(
    await measure('事件风暴下切换 设置→收件箱（6 次）', async () => {
      const timer = setInterval(() => {
        void page.evaluate(() => { window.__fireProgress?.(); window.__fireNewMail?.(Math.floor(Math.random() * 90)) }).catch(() => {})
      }, 150)
      for (let i = 0; i < 6; i += 1) {
        await page.click('[data-nav="settings"]')
        await page.waitForTimeout(150)
        await page.click('[data-nav="folder:INBOX"]')
        await page.waitForTimeout(350)
      }
      clearInterval(timer)
    })
  )
} else {
  results.push(
    await measure('切换 设置→收件箱（6 次，无事件风暴）', async () => {
      for (let i = 0; i < 6; i += 1) {
        await page.click('[data-nav="settings"]')
        await page.waitForTimeout(200)
        await page.click('[data-nav="folder:INBOX"]')
        await page.waitForTimeout(300)
      }
    })
  )
}

results.push(
  await measure('滚动到底再回顶', async () => {
    await page.evaluate(() => { const el = document.querySelector('.mail-list'); if (el) el.scrollTop = el.scrollHeight })
    await page.waitForTimeout(400)
    await page.evaluate(() => { const el = document.querySelector('.mail-list'); if (el) el.scrollTop = 0 })
    await page.waitForTimeout(300)
  })
)

const stats = await page.evaluate(() => ({
  rows: document.querySelectorAll('.mail-item').length,
  nodes: document.getElementsByTagName('*').length,
  heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null
}))

await page.screenshot({ path: path.join(OUT, `perf-${COUNT}${BURST ? '-burst' : ''}.png`) })
await browser.close()
server.close()

const report = { count: COUNT, burst: BURST, firstPaintMs, domRowsAfterLoadMore: domRows, results, ...stats }
fs.writeFileSync(path.join(OUT, `perf-${COUNT}${BURST ? '-burst' : ''}.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

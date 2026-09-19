/**
 * 切换延迟精测：分别量「进设置」「进收件箱」「进 AI」的单次耗时（含主线程长任务）。
 * 用法：node perf-switch.mjs [count]
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright-core'

const COUNT = Number.parseInt(process.argv[2] ?? '3000', 10)
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
await new Promise((r) => server.listen(8151, '127.0.0.1', r))
const candidates = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
const executablePath = candidates.find((p) => fs.existsSync(p))
const browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
await page.addInitScript(() => {
  window.__longTasks = []
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push(Math.round(e.duration)) }).observe({ entryTypes: ['longtask'] }) } catch { /* ignore */ }
})
await page.goto(`http://127.0.0.1:8151/index.html?count=${COUNT}`, { waitUntil: 'load' })
await page.waitForTimeout(300)
await page.click('button:has-text("开始登录")')
await page.waitForSelector('.mail-list .mail-item', { timeout: 60000 })
await page.waitForTimeout(1500)

const probe = async (label, clickSel, expectSel) => {
  await page.evaluate(() => { window.__longTasks = [] })
  const res = await page.evaluate(
    async ([sel, expect]) => {
      const t0 = performance.now()
      const btn = document.querySelector(sel)
      if (!btn) return { err: `缺少 ${sel}` }
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // 等两帧 + 目标元素出现
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      let appeared = -1
      for (let i = 0; i < 120; i += 1) {
        if (document.querySelector(expect)) { appeared = performance.now() - t0; break }
        await new Promise((r) => setTimeout(r, 8))
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
      return { clickToExpect: Math.round(appeared), clickToPainted: Math.round(performance.now() - t0) }
    },
    [clickSel, expectSel]
  )
  const long = await page.evaluate(() => (window.__longTasks || []).slice())
  await page.waitForTimeout(250)
  return { label, ...res, longMax: long.length ? Math.max(...long) : 0, longCount: long.length }
}

const out = []
for (let i = 0; i < 3; i += 1) {
  out.push(await probe('收件箱 → 设置', '[data-nav="settings"]', '[data-testid="settings-page"]'))
  out.push(await probe('设置 → 收件箱', '[data-nav="folder:INBOX"]', '.mail-item'))
  out.push(await probe('收件箱 → AI 助手', '[data-nav="ai"]', '[data-testid="chat-list"]'))
  out.push(await probe('AI 助手 → 收件箱', '[data-nav="folder:INBOX"]', '.mail-item'))
  out.push(await probe('收件箱 → 知识库', '[data-nav="knowledge"]', '[data-testid="kb-page"]'))
  out.push(await probe('知识库 → 收件箱', '[data-nav="folder:INBOX"]', '.mail-item'))
}
console.log(JSON.stringify({ count: COUNT, probes: out }, null, 2))
fs.writeFileSync(path.join(OUT, `perf-switch-${COUNT}.json`), JSON.stringify({ count: COUNT, probes: out }, null, 2))
await browser.close()
server.close()

// 截图：拦截发件人（列表折叠条 / 已拦截视图 / 设置里的规则）
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const DIST = path.join(root, 'out', 'renderer')
const OUT = path.join(root, 'docs', 'design', 'block')
fs.mkdirSync(OUT, { recursive: true })
const PORT = 8281
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }
const server = http.createServer((req, res) => {
  const rel = (req.url || '/').split('?')[0] === '/' ? 'index.html' : (req.url || '').split('?')[0].replace(/^\//, '')
  fs.readFile(path.join(DIST, rel), (e, d) => {
    if (e) { res.writeHead(404); res.end('nf'); return }
    res.writeHead(200, { 'content-type': MIME[path.extname(rel)] || 'application/octet-stream' })
    res.end(d)
  })
})
await new Promise((r) => server.listen(PORT, r))
const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
page.on('dialog', (d) => d.accept())
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' })
await page.waitForTimeout(400)
await page.click('button:has-text("开始登录")')
await page.waitForSelector('.mail-list .mail-item', { timeout: 15000 })
// 打开一封邮件并拦截
await page.locator('.mail-list .mail-item').first().click()
await page.waitForTimeout(500)
await page.click('[data-testid="block-sender-btn"]')
await page.waitForTimeout(900)
await page.screenshot({ path: path.join(OUT, '1-block-detail.png') })
// 点折叠条 → 已拦截视图
await page.click('[data-testid="blocked-fold"]')
await page.waitForTimeout(700)
await page.screenshot({ path: path.join(OUT, '2-blocked-view.png') })
// 设置里的规则
await page.click('[data-nav="settings"]')
await page.waitForTimeout(500)
await page.click('[data-testid="settings-section-sync"]')
await page.waitForTimeout(500)
const rulesList = await page.locator('[data-testid="block-rules-list"]')
if (await rulesList.count()) {
  await rulesList.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
}
await page.screenshot({ path: path.join(OUT, '3-block-settings.png') })
console.log('screenshots ok')
await browser.close()
server.close()

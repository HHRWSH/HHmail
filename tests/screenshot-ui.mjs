// 临时：截图审查（待办 / 收件箱 / 设置，亮暗两套）
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const DIST = path.join(root, 'out', 'renderer')
const PORT = 8211
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
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
const shots = []
async function capture(theme) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme === 'dark' ? 'dark' : 'light'
  })
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem('mail-ai-theme', t)
    } catch {}
  }, theme)
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' })
  await page.waitForTimeout(400)
  await page.click('button:has-text("开始登录")')
  await page.waitForSelector('.mail-list .mail-item', { timeout: 15000 })
  await page.locator('.mail-list .mail-item').first().click()
  await page.waitForTimeout(500)
  const out1 = path.join(root, `docs/design/ui-inbox-${theme}.png`)
  await page.screenshot({ path: out1 })
  shots.push(out1)
  await page.click('[data-nav="tasks"]')
  await page.waitForSelector('[data-testid="tasks-page"]', { timeout: 8000 })
  await page.locator('[data-testid="task-item"]').first().click()
  await page.waitForSelector('[data-testid="task-memo"]', { timeout: 5000 })
  await page.waitForTimeout(400)
  const out2 = path.join(root, `docs/design/ui-tasks-${theme}.png`)
  await page.screenshot({ path: out2 })
  shots.push(out2)
  await page.click('[data-nav="settings"]')
  await page.waitForTimeout(600)
  const out3 = path.join(root, `docs/design/ui-settings-${theme}.png`)
  await page.screenshot({ path: out3 })
  shots.push(out3)
  await page.close()
}
await capture('light')
await capture('dark')
console.log(shots.join('\n'))
await browser.close()
server.close()

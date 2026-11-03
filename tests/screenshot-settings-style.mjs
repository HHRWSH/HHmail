// 截图：设置 → 外观（视觉风格整块选择器）亮/暗
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const DIST = path.join(root, 'out', 'renderer')
const OUT = path.join(root, 'docs', 'design', 'settings-style-picker')
fs.mkdirSync(OUT, { recursive: true })
const PORT = 8293
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

async function shot(name, dark = false) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: dark ? 'dark' : 'light' })
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' })
  await page.waitForTimeout(350)
  await page.click('button:has-text("开始登录")')
  await page.waitForSelector('.mail-list .mail-item', { timeout: 15000 })
  await page.click('[data-nav="settings"]')
  await page.waitForTimeout(500)
  await page.click('[data-testid="settings-section-appearance"]')
  await page.waitForTimeout(400)
  // 让风格选择器进入视口
  const picker = await page.$('[data-testid="set-ui-style"]')
  if (picker) await picker.scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(OUT, `${name}.png`) })
  console.log(path.join(OUT, `${name}.png`))
  await page.close()
}

await shot('1-appearance-light', false)
await shot('2-appearance-dark', true)
await browser.close()
server.close()

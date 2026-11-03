// 截图：新版自绘标题栏（亮色 / 暗色 / 玻璃风格）
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const DIST = path.join(root, 'out', 'renderer')
const OUT = path.join(root, 'docs', 'design', 'titlebar')
fs.mkdirSync(OUT, { recursive: true })
const PORT = 8291
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

async function shot(name, opts = {}) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: opts.dark ? 'dark' : 'light'
  })
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' })
  await page.waitForTimeout(400)
  await page.click('button:has-text("开始登录")')
  await page.waitForSelector('.mail-list .mail-item', { timeout: 15000 })
  if (opts.style) {
    await page.evaluate((s) => {
      document.documentElement.dataset.style = s
    }, opts.style)
  }
  if (opts.openMail) {
    await page.locator('.mail-list .mail-item').first().click()
    await page.waitForTimeout(500)
  }
  if (opts.hover) {
    const el = await page.$(`[data-testid="${opts.hover}"]`)
    if (el) await el.hover()
    await page.waitForTimeout(250)
  }
  const file = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: file })
  console.log(file)
  await page.close()
}

await shot('1-titlebar-light', { openMail: true })
await shot('2-titlebar-dark', { dark: true, openMail: true })
await shot('3-titlebar-glass', { dark: true, style: 'glass', openMail: true })
await shot('4-titlebar-hover-close', { openMail: true, hover: 'win-close' })
await browser.close()
server.close()

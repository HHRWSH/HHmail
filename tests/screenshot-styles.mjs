// 截图：5 套风格 × 亮/暗（收件箱页），生成对比总图
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const DIST = path.join(root, 'out', 'renderer')
const OUT = path.join(root, 'docs', 'design', 'styles-switch')
fs.mkdirSync(OUT, { recursive: true })
const PORT = 8233
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

const styles = ['apple', 'linear', 'notion', 'paper', 'glass']
const labels = { apple: 'Apple 原生', linear: 'Linear 工具', notion: 'Notion 暖白', paper: '纸张编辑', glass: '玻璃拟态' }
const browser = await chromium.launch({ channel: 'msedge' })
const shots = {}

for (const mode of ['light', 'dark']) {
  for (const style of styles) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: mode === 'dark' ? 'dark' : 'light'
    })
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' })
    await page.waitForTimeout(350)
    await page.click('button:has-text("开始登录")')
    await page.waitForSelector('.mail-list .mail-item', { timeout: 15000 })
    await page.evaluate((s) => {
      document.documentElement.dataset.style = s
    }, style)
    await page.locator('.mail-list .mail-item').first().click()
    await page.waitForTimeout(500)
    const out = path.join(OUT, `${style}-${mode}.png`)
    await page.screenshot({ path: out })
    shots[`${style}-${mode}`] = out
    console.log(out)
    await page.close()
  }
}

// 对比总图：5 列 × 2 行
const cell = (style, mode) => `<div class="cell"><div class="cap">${labels[style]} · ${mode === 'light' ? '亮色' : '暗色'}</div><img src="file:///${shots[`${style}-${mode}`].replace(/\\/g, '/')}" /></div>`
const sheet = `<!doctype html><html><head><meta charset="utf-8"><style>
 body{margin:0;padding:18px;background:#0f1115;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
 h1{color:#eef2ff;font-size:20px;margin:0 0 4px}
 .sub{color:#8b93a7;font-size:12px;margin-bottom:14px}
 .grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
 .cell{background:#191c22;border-radius:12px;padding:8px;border:1px solid rgba(255,255,255,.08)}
 .cap{color:#cfd6e4;font-size:11.5px;font-weight:600;margin-bottom:6px}
 img{width:100%;border-radius:6px;display:block}
</style></head><body>
<h1>HHmail 视觉风格切换（5 套 × 亮/暗，同布局）</h1>
<div class="sub">设置 → 外观 → 视觉风格 里一键切换；下面是同一界面在亮/暗两种模式下的效果</div>
<div class="grid">${styles.map((s) => cell(s, 'light')).join('')}${styles.map((s) => cell(s, 'dark')).join('')}</div>
</body></html>`
const sheetPath = path.join(OUT, 'compare-styles.html')
fs.writeFileSync(sheetPath, sheet, 'utf8')
const page = await browser.newPage({ viewport: { width: 1900, height: 1000 }, deviceScaleFactor: 1 })
await page.goto('file:///' + sheetPath.replace(/\\/g, '/'), { waitUntil: 'load' })
await page.waitForTimeout(700)
const sheetPng = path.join(OUT, 'compare-styles.png')
await page.screenshot({ path: sheetPng, fullPage: true })
console.log(sheetPng)
await browser.close()
server.close()

// 给 5 套风格 demo 截图 + 生成一张对比总图
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const dir = path.join(root, 'docs', 'design', 'styles')
const browser = await chromium.launch({ channel: 'msedge' })

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html') && f.startsWith('style-')).sort()
const shots = []
for (const f of files) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  await page.goto('file:///' + path.join(dir, f).replace(/\\/g, '/'), { waitUntil: 'load' })
  await page.waitForTimeout(350)
  const out = path.join(dir, f.replace('.html', '.png'))
  await page.screenshot({ path: out })
  shots.push(out)
  console.log(out)
  await page.close()
}

// 对比总图：2 列网格 + 标题
const captions = ['1. Apple 原生风', '2. Linear 深色工具风', '3. Notion 暖白极简风', '4. 纸张编辑风', '5. 玻璃拟态（Arc 风）']
const cell = (i) => `
  <div class="cell">
    <div class="cap">${captions[i] || ''}</div>
    <img src="file:///${shots[i].replace(/\\/g, '/')}" />
  </div>`
const sheet = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 18px; background: #12141a; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  h1 { color: #eef2ff; font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8b93a7; font-size: 12px; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .cell { background: #1b1e26; border-radius: 14px; padding: 10px; border: 1px solid rgba(255,255,255,0.08); }
  .cap { color: #cfd6e4; font-size: 13px; font-weight: 600; margin-bottom: 8px; }
  img { width: 100%; border-radius: 8px; display: block; }
</style></head><body>
  <h1>HHmail 视觉风格候选（同一界面 · 5 种风格）</h1>
  <div class="sub">按 1–5 选一个，或告诉我要哪几套混搭；也可以说“某套的某处不喜欢”</div>
  <div class="grid">${captions.map((_, i) => cell(i)).join('')}</div>
</body></html>`
const sheetPath = path.join(dir, 'compare.html')
fs.writeFileSync(sheetPath, sheet, 'utf8')
const page = await browser.newPage({ viewport: { width: 1500, height: 1900 }, deviceScaleFactor: 1 })
await page.goto('file:///' + sheetPath.replace(/\\/g, '/'), { waitUntil: 'load' })
await page.waitForTimeout(600)
const sheetPng = path.join(dir, 'compare.png')
await page.screenshot({ path: sheetPng, fullPage: true })
console.log(sheetPng)
await browser.close()

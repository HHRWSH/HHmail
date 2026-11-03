// 给 5 套「排版架构」demo 截图 + 对比总图
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const dir = path.join(root, 'docs', 'design', 'layouts')
const browser = await chromium.launch({ channel: 'msedge' })
const files = fs.readdirSync(dir).filter((f) => f.startsWith('layout-') && f.endsWith('.html')).sort()
const shots = []
for (const f of files) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  await page.goto('file:///' + path.join(dir, f).replace(/\\/g, '/'), { waitUntil: 'load' })
  await page.waitForTimeout(300)
  const out = path.join(dir, f.replace('.html', '.png'))
  await page.screenshot({ path: out })
  shots.push(out)
  console.log(out)
  await page.close()
}
const captions = [
  'L1 聊天式（Twobird/Slack 风）',
  'L2 卡片流（Feed/社交风）',
  'L3 看板（Kanban 状态列）',
  'L4 终端表格（Bloomberg/高密度）',
  'L5 仪表盘（统计+邮件+待办一体）'
]
const cell = (i) => `<div class="cell"><div class="cap">${captions[i] || ''}</div><img src="file:///${shots[i].replace(/\\/g, '/')}" /></div>`
const sheet = `<!doctype html><html><head><meta charset="utf-8"><style>
 body{margin:0;padding:18px;background:#12141a;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
 h1{color:#eef2ff;font-size:20px;margin:0 0 4px}
 .sub{color:#8b93a7;font-size:12px;margin-bottom:16px}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
 .cell{background:#1b1e26;border-radius:14px;padding:10px;border:1px solid rgba(255,255,255,.08)}
 .cap{color:#cfd6e4;font-size:13px;font-weight:600;margin-bottom:8px}
 img{width:100%;border-radius:8px;display:block}
</style></head><body><h1>HHmail 排版架构候选（5 种完全不同的界面结构）</h1><div class="sub">同一批邮件内容；差别在「信息架构」而不是换皮。HTML 可双击浏览器打开</div><div class="grid">${captions.map((_, i) => cell(i)).join('')}</div></body></html>`
const sheetPath = path.join(dir, 'compare-layouts.html')
fs.writeFileSync(sheetPath, sheet, 'utf8')
const page = await browser.newPage({ viewport: { width: 1500, height: 1900 }, deviceScaleFactor: 1 })
await page.goto('file:///' + sheetPath.replace(/\\/g, '/'), { waitUntil: 'load' })
await page.waitForTimeout(500)
const sheetPng = path.join(dir, 'compare-layouts.png')
await page.screenshot({ path: sheetPng, fullPage: true })
console.log(sheetPng)
await browser.close()

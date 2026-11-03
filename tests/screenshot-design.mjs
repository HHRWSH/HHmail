// 临时脚本：给设计预览 HTML 截图（亮/暗两张），供用户审查
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const htmlPath = path.join(root, 'docs/design/tasks-memo-mockup.html')
const url = 'file:///' + htmlPath.replace(/\\/g, '/')

const browser = await chromium.launch({ channel: 'msedge' })
for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  await page.goto(url, { waitUntil: 'load' })
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t
  }, theme)
  await page.waitForTimeout(250)
  const out = path.join(root, `docs/design/tasks-memo-${theme}.png`)
  await page.screenshot({ path: out, fullPage: false })
  console.log(`已保存 ${out}`)
  await page.close()
}
await browser.close()

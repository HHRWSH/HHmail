import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown —— 轻量 Markdown 渲染（摘要/问答展示）', () => {
  it('标题、粗体、行内代码', () => {
    const html = renderMarkdown('## 主旨\n这是 **重要** 的 `code`')
    expect(html).toContain('<h4>主旨</h4>')
    expect(html).toContain('<strong>重要</strong>')
    expect(html).toContain('<code>code</code>')
  })

  it('无序列表与任务清单', () => {
    const html = renderMarkdown('- 时间：09-15\n- [ ] 完成选课\n- [x] 已缴费')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>时间：09-15</li>')
    expect(html).toContain('☐ 完成选课')
    expect(html).toContain('☑ 已缴费')
  })

  it('有序列表', () => {
    const html = renderMarkdown('1. 第一步\n2. 第二步')
    expect(html).toContain('<ol>')
    expect(html.match(/<li>/g)?.length).toBe(2)
  })

  it('表格（关键信息用）', () => {
    const html = renderMarkdown('| 项目 | 内容 |\n| --- | --- |\n| 时间 | 2026-09-15 10:00 |\n| 截止 | 2026-09-20 23:59 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>项目</th>')
    expect(html).toContain('<td>2026-09-15 10:00</td>')
    expect(html).toContain('<td>2026-09-20 23:59</td>')
  })

  it('引用与分割线', () => {
    const html = renderMarkdown('> 原文引用\n\n---')
    expect(html).toContain('<blockquote>原文引用</blockquote>')
    expect(html).toContain('<hr>')
  })

  it('链接只允许 http/https', () => {
    expect(renderMarkdown('[页面](https://example.com/a)')).toContain('<a href="https://example.com/a"')
    expect(renderMarkdown('[危险](javascript:alert(1))')).not.toContain('<a ')
  })

  it('HTML 注入被转义（防 XSS）', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('空输入返回空串', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown(null)).toBe('')
  })
})

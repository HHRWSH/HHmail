// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeHtml, sanitizeLink } from './sanitize'

describe('HTML 正文净化（规范 §2 第 10 条）', () => {
  it('剥离 script / 事件属性 / iframe', () => {
    const dirty = '<p>你好</p><script>alert(1)</script><img src="x" onerror="alert(1)"><iframe src="https://evil"></iframe>'
    const clean = sanitizeHtml(dirty, { allowRemoteImages: true })
    expect(clean).toContain('你好')
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('onerror')
    expect(clean).not.toContain('<iframe')
  })

  it('默认不加载远程图片：<img> 全部移除（防跟踪像素）', () => {
    const html = '<p>正文</p><img src="https://track.example.com/pixel.gif"><img src="cid:inline">'
    const clean = sanitizeHtml(html)
    expect(clean).not.toContain('<img')
    expect(clean).toContain('正文')
  })

  it('显式放行图片时：允许 http(s)/data:/cid:，仍剥离非法协议', () => {
    const html = '<img src="https://ok.example.com/a.png"><img src="cid:inline"><img src="javascript:alert(1)"><img src="file:///etc/passwd">'
    const clean = sanitizeHtml(html, { allowRemoteImages: true })
    expect(clean).toContain('https://ok.example.com/a.png')
    expect(clean).toContain('cid:inline')
    expect(clean).not.toContain('javascript:')
    expect(clean).not.toContain('file://')
  })

  it('javascript: 链接被剥离', () => {
    const clean = sanitizeHtml('<a href="javascript:alert(1)">点我</a>', { allowRemoteImages: true })
    expect(clean).not.toContain('javascript:')
  })

  it('sanitizeLink 只放行 http(s)', () => {
    expect(sanitizeLink('https://example.edu')).toBe('https://example.edu')
    expect(sanitizeLink('javascript:alert(1)')).toBe('#')
    expect(sanitizeLink('file:///x')).toBe('#')
  })
})

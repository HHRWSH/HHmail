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

  it('不显示图片时：只移除**远程**图片（c 防跟踪像素），内嵌 cid: 保留', () => {
    const html = '<p>正文</p><img src="https://track.example.com/pixel.gif"><img src="cid:inline">'
    const clean = sanitizeHtml(html)
    expect(clean).not.toContain('track.example.com')
    // 内嵌图片属于邮件自身内容，不该被误删（旧实现把 data:/cid: 一起删了 → 图片型邮件变空白）
    expect(clean).toContain('cid:inline')
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

describe('邮件图片策略（真机反馈：图片型邮件打开一片空白）', () => {
  const html = '<p>hi</p><img src="https://tracker.example.com/a.png"><img src="data:image/png;base64,AAA"><img src="cid:logo@x">'

  it('默认（显示图片）→ 远程与内嵌都保留', () => {
    const out = sanitizeHtml(html, { allowRemoteImages: true })
    expect(out).toContain('https://tracker.example.com/a.png')
    expect(out).toContain('data:image/png;base64,AAA')
    expect(out).toContain('cid:logo@x')
  })

  it('关掉显示图片 → 只拦远程图，内嵌 data:/cid: 仍保留（那是邮件自身内容）', () => {
    const out = sanitizeHtml(html, { allowRemoteImages: false })
    expect(out).not.toContain('tracker.example.com')
    expect(out).toContain('data:image/png;base64,AAA')
    expect(out).toContain('cid:logo@x')
  })

  it('非常规协议的图片一律剥掉（javascript: / 相对路径）', () => {
    const out = sanitizeHtml('<img src="javascript:alert(1)"><img src="/local.png">', { allowRemoteImages: true })
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('/local.png')
  })
})

import { describe, expect, it } from 'vitest'
import { normalizeParsed, parseRawMessage, plainFromHtml, type ParsedMailLike } from './mime'
import { buildSimpleEml } from '../../../tests/helpers/fakes'

describe('normalizeParsed —— mailparser 结果映射（fake 输入，不依赖真实邮箱）', () => {
  it('映射主题/发件人/收件人/时间/正文/摘要', () => {
    const parsed: ParsedMailLike = {
      subject: '测试邮件',
      from: { value: [{ name: '林教授', address: 'lin@example.edu' }] },
      to: { value: [{ name: '', address: 'me@link.example.edu' }] },
      cc: { value: [{ address: 'cc@example.edu' }] },
      date: new Date(1_760_000_000_000),
      messageId: '<m1@x>',
      references: ['<r1@x>', '<r2@x>'],
      inReplyTo: '<r2@x>',
      text: '正文内容',
      html: '<p>正文</p>',
      attachments: []
    }
    const msg = normalizeParsed(parsed, 42, ['\\Seen'])
    expect(msg.uid).toBe(42)
    expect(msg.subject).toBe('测试邮件')
    expect(msg.fromName).toBe('林教授')
    expect(msg.fromAddr).toBe('lin@example.edu')
    expect(msg.toAddrs).toEqual(['me@link.example.edu'])
    expect(msg.ccAddrs).toEqual(['cc@example.edu'])
    expect(msg.dateTs).toBe(1_760_000_000_000)
    expect(msg.messageId).toBe('<m1@x>')
    expect(msg.references).toEqual(['<r1@x>', '<r2@x>'])
    expect(msg.inReplyTo).toBe('<r2@x>')
    expect(msg.bodyText).toBe('正文内容')
    expect(msg.bodyHtml).toBe('<p>正文</p>')
    expect(msg.snippet).toBe('正文内容')
    expect(msg.flags).toEqual(['\\Seen'])
  })

  it('空主题兜底（无主题）', () => {
    const msg = normalizeParsed({}, 1)
    expect(msg.subject).toBe('(无主题)')
    expect(msg.fromAddr).toBe('')
  })

  it('inline 内嵌图片（有 cid）不进附件列表；真实附件保留', () => {
    const parsed: ParsedMailLike = {
      attachments: [
        { partId: '1.2', filename: 'logo.png', contentType: 'image/png', size: 100, contentId: '<img1@x>', contentDisposition: 'inline' },
        { partId: '2', filename: '报告.pdf', contentType: 'application/pdf', size: 2000, contentDisposition: 'attachment' }
      ]
    }
    const msg = normalizeParsed(parsed, 1)
    expect(msg.attachments).toHaveLength(1)
    expect(msg.attachments[0].filename).toBe('报告.pdf')
    expect(msg.attachments[0].disposition).toBe('attachment')
  })

  it('references 为字符串时按空白拆分', () => {
    const msg = normalizeParsed({ references: '<a@x>  <b@x>' }, 1)
    expect(msg.references).toEqual(['<a@x>', '<b@x>'])
  })

  it('html=false（纯文本邮件）→ bodyHtml=null', () => {
    const msg = normalizeParsed({ html: false, text: 'plain' }, 1)
    expect(msg.bodyHtml).toBeNull()
    expect(msg.bodyText).toBe('plain')
  })

  it('纯 HTML 邮件（text 为空）→ 从 HTML 提取纯文本兜底（AI 总结能读到正文）', () => {
    const msg = normalizeParsed(
      {
        html: '<p>Graduate jobs have <b>plummeted</b> by 60%.</p><p>请留意截止日期：12 月 8 日。</p>',
        text: ''
      },
      1
    )
    expect(msg.bodyText).toContain('Graduate jobs have plummeted by 60%')
    expect(msg.bodyText).toContain('12 月 8 日')
    expect(msg.bodyText).not.toContain('<p>')
  })
})

describe('plainFromHtml —— HTML→纯文本', () => {
  it('剥离标签与实体，块级标签转换为换行（保留段落结构）', () => {
    const out = plainFromHtml('<div>你好&nbsp;世界</div><p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>')
    // 段落之间保留换行：详情页 <pre> 与 AI 都能读出结构
    expect(out).toBe('你好 世界\n1 < 2 && 3 > 2')
  })

  it('剔除 style/script 内容', () => {
    const out = plainFromHtml('<style>.a{color:red}</style><script>alert(1)</script><p>正文</p>')
    expect(out).toContain('正文')
    expect(out).not.toContain('color:red')
    expect(out).not.toContain('alert')
  })

  it('空输入返回空串；超长截断', () => {
    expect(plainFromHtml(null)).toBe('')
    expect(plainFromHtml('')).toBe('')
    // 截断会补省略号（≤ maxChars + 1），且不切断代理对
    expect(plainFromHtml('<p>' + 'a'.repeat(100) + '</p>', 20)).toBe('a'.repeat(20) + '…')
  })
})

describe('parseRawMessage —— 真实 mailparser 解析构造 EML', () => {
  it('中文主题（RFC2047 编码）与正文正确解码', async () => {
    const raw = buildSimpleEml('选课通知', '请在本月底前完成选课。')
    const msg = await parseRawMessage(raw, 7)
    expect(msg.subject).toBe('选课通知')
    expect(msg.bodyText).toContain('选课')
    expect(msg.fromAddr).toBe('a@example.edu')
  })

  it('多部分 alternative（text+html）两种都保留', async () => {
    const raw = Buffer.from(
      [
        'From: a@example.edu',
        'To: me@link.example.edu',
        'Subject: multi',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="B"',
        '',
        '--B',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '纯文本部分',
        '--B',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>HTML 部分</p>',
        '--B--'
      ].join('\r\n'),
      'utf8'
    )
    const msg = await parseRawMessage(raw, 8)
    expect(msg.bodyText).toContain('纯文本部分')
    expect(msg.bodyHtml).toContain('HTML 部分')
  })

  it('带 References 头的 EML 解析出引用链', async () => {
    const raw = buildSimpleEml('回复: 论文', '正文', 'a@example.edu', {
      messageId: '<new@x>',
      refs: '<old1@x> <old2@x>'
    })
    const msg = await parseRawMessage(raw, 9)
    expect(msg.references).toContain('<old1@x>')
    expect(msg.messageId).toBe('<new@x>')
  })
})

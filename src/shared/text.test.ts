import { describe, expect, it } from 'vitest'
import { cleanMailText, formatPromptDate, isCssHeavy, plainFromHtml, sanitizeForModel, stripCssNoise, truncateSafe } from './text'

/** 真机样本：Blackboard 通知邮件的 text 部分（<style> 的 CSS 混在正文里） */
const CSS_LADEN = `@import url(http://fonts.googleapis.com/css?family=Open+Sans:400,600,700);

  /* Take care of image borders and formatting */

  img {
    max-width: 600px;
    outline: none;
    text-decoration: none;
    -ms-interpolation-mode: bicubic;
  }
  a { text-decoration: none !important; }
  @media screen and (max-width: 600px) { .container { width: 100% !important; } }

Welcome to "MAE Career and Internship 2026-27"

Dear Students,
The Department will use this platform to share career and internship opportunities.
Best regards, Vicky Long, MAE General Office`

const HTML_VERSION = `<html><head><style>img{max-width:600px}@media screen{.a{width:100%}}</style></head>
<body><p>Welcome to "MAE Career and Internship 2026-27"</p><p>Dear Students,</p>
<p>The Department will use this platform to share career opportunities.</p><p>Best regards, Vicky Long</p></body></html>`

describe('shared/text —— 正文清洗（V2.1 真机回归：HTML 邮件的 CSS 混进正文）', () => {
  it('isCssHeavy 能识别 CSS 噪声正文', () => {
    expect(isCssHeavy(CSS_LADEN)).toBe(true)
    expect(isCssHeavy('这是一封普通通知邮件，正文没有任何样式代码。')).toBe(false)
  })

  it('stripCssNoise 去掉 CSS 规则块与注释，保留可读正文', () => {
    const out = stripCssNoise(CSS_LADEN)
    expect(out).not.toContain('max-width')
    expect(out).not.toContain('@media')
    expect(out).toContain('Welcome to "MAE Career and Internship 2026-27"')
    expect(out).toContain('Vicky Long')
  })

  it('cleanMailText：正文是 CSS 噪声时改用 HTML 版本（AI 不再看到样式代码）', () => {
    const out = cleanMailText(CSS_LADEN, HTML_VERSION)
    expect(out).not.toContain('max-width')
    expect(out).not.toContain('@media')
    expect(out).toContain('MAE Career and Internship')
    expect(out).toContain('Vicky Long')
  })

  it('cleanMailText：干净正文原样保留（只做缩进空白压缩）', () => {
    const plain = '关于毕业论文进度的沟通\n请补充第三章实验数据，周五前回复。'
    expect(cleanMailText(plain, null)).toBe(plain)
  })

  it('cleanMailText：bodyText 为空 → 用 HTML 转文本兜底', () => {
    const out = cleanMailText('', HTML_VERSION)
    expect(out).toContain('Welcome to')
  })

  it('plainFromHtml：去 style/script、解实体、段落换行', () => {
    const out = plainFromHtml('<style>p{color:red}</style><p>A&amp;B</p><script>x()</script><div>C&lt;D</div>')
    expect(out).not.toContain('color:red')
    expect(out).not.toContain('x()')
    expect(out).toContain('A&B')
    expect(out).toContain('C<D')
  })
})

describe('formatPromptDate —— 给 AI 的日期统一本地时区（V2.1：UTC/本地打架修复）', () => {
  it('用北京时间标注，而不是 UTC', () => {
    // 2026-09-10 08:14 UTC == 16:14 北京时间
    const ts = Date.UTC(2026, 8, 10, 8, 14)
    const out = formatPromptDate(ts)
    expect(out).toContain('2026-09-10')
    expect(out).toContain('16:14')
    expect(out).toContain('北京时间')
  })

  it('时间未知时明确写「未知」，不输出 1970 年', () => {
    expect(formatPromptDate(0)).toBe('未知')
  })
})

describe('decodeEntities —— HTML 实体解码（V2.1）', () => {
  it('解码排版实体与数字实体', async () => {
    const { decodeEntities } = await import('./text')
    expect(decodeEntities('&ldquo;MAE&rdquo; &mdash; &hellip; &#39;&#x27;')).toBe('“MAE” — … \'\'')
    expect(decodeEntities('A&nbsp;B &amp; C')).toBe('A B & C')
  })

  it('plainFromHtml 输出已解码实体（AI 读到的是可读文本）', async () => {
    const { plainFromHtml } = await import('./text')
    const out = plainFromHtml('<p>Welcome to &ldquo;MAE Career&rdquo;</p>')
    expect(out).toBe('Welcome to “MAE Career”')
  })

  // 真机根因：HTML 邮件把 emoji 写成代理项数字实体，解码后变成孤立代理项 → DeepSeek 400 hex escape
  it('相邻的高/低代理项实体合并成真正的 emoji（不产生孤立代理项）', async () => {
    const { decodeEntities, plainFromHtml } = await import('./text')
    expect(decodeEntities('&#55357;&#56832;')).toBe('😀')
    expect(decodeEntities('&#xD83D;&#xDE00;')).toBe('😀')
    expect(decodeEntities('&#55357;&#56832; &amp; &#xD83D;&#xDE00;')).toBe('😀 & 😀')
    expect(plainFromHtml('<p>A&#55357;&#56832;B</p>')).toBe('A😀B')
  })

  it('落单的代理项实体直接丢弃（绝不放孤立代理项进入模型输入）', async () => {
    const { decodeEntities, plainFromHtml } = await import('./text')
    expect(decodeEntities('&#55357;abc&#56832;')).toBe('abc')
    expect(decodeEntities('&#xD83D;x')).toBe('x')
    expect(decodeEntities('x&#xDE00;')).toBe('x')
    expect(decodeEntities('&#55357; &#56832;')).toBe(' ')
    expect(plainFromHtml('<p>&#55357;</p>')).toBe('')
  })

  it('非法数字实体（0 / 超范围 / 控制字符）不进入文本', async () => {
    const { decodeEntities } = await import('./text')
    expect(decodeEntities('a&#0;b')).toBe('ab')
    expect(decodeEntities('a&#x110000;b')).toBe('ab')
    expect(decodeEntities('a&#1;b')).toBe('ab')
    expect(decodeEntities('a&#9;b')).toBe('a\tb')
  })
})

describe('sanitizeForModel / truncateSafe —— 模型输入安全（V2.1 真机回归：400 hex escape）', () => {
  it('去掉孤立代理项（emoji 被截半），保留正常 emoji', () => {
    const half = 'abc\uD83D'          // 半个 emoji（高代理项孤立）
    const half2 = 'abc\uDE00'         // 孤立低代理项
    const ok = 'abc😀def'
    expect(sanitizeForModel(half)).toBe('abc')
    expect(sanitizeForModel(half2)).toBe('abc')
    expect(sanitizeForModel(ok)).toBe(ok)
  })

  it('truncateSafe 不会把 emoji 切成两半', () => {
    const text = 'aaaa😀bbbb'
    const out = truncateSafe(text, 5) // 切在 emoji 中间的位置
    expect(out.endsWith('…')).toBe(true)
    expect(out).toBe('aaaa…')
    // 结果里不允许出现孤立代理项（JSON 序列化必须合法）
    expect(JSON.parse(JSON.stringify({ out })).out).toBe(out)
  })

  it('去掉非法控制字符，保留换行与制表符', () => {
    expect(sanitizeForModel('a\u0000b\u0007c')).toBe('a b c')
    expect(sanitizeForModel('a\nb\tc')).toBe('a\nb\tc')
  })
})

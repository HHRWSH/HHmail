/**
 * 纯文本处理（无第三方依赖，主进程与渲染进程共用）：
 * - plainFromHtml：HTML → 纯文本（去 style/script、解实体、块级标签转换行）
 * - stripCssNoise / isCssHeavy / cleanMailText：清理「HTML 邮件正文被当成纯文本」的 CSS 噪声
 * - sanitizeForModel / truncateSafe：喂给模型前去掉孤立 UTF-16 代理项、按字符安全截断
 * - formatPromptDate：给 AI 的日期一律用本地时区（Asia/Hong_Kong）并标注，避免 UTC/本地时间打架
 */

/**
 * 常见 HTML 实体解码（含排版实体与数字实体）。
 * 真机教训：有些 HTML 邮件把 emoji 写成 UTF-16 代理项的数字实体（`&#55357;&#56832;`），
 * 而 `String.fromCodePoint(0xD83D)` 会造出「孤立代理项」——JSON 序列化后是非法转义
 * `\ud83d`，DeepSeek 直接 400（unexpected end of hex escape）→「AI 助手不能用」。
 * 因此这里按 HTML 规范处理数字实体：
 * - 相邻的「高代理项 + 低代理项」实体合并成一个真正的字符；
 * - 落单的代理项（解析错误）直接丢弃，绝不产生孤立代理项；
 * - 超出 Unicode 范围或 0 的实体丢弃。
 */
export function decodeEntities(text: string | null | undefined): string {
  const named: Record<string, string> = {
    nbsp: ' ',
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    ldquo: '“',
    rdquo: '”',
    lsquo: '‘',
    rsquo: '’',
    mdash: '—',
    ndash: '–',
    hellip: '…',
    bull: '•',
    middot: '·',
    times: '×',
    laquo: '«',
    raquo: '»',
    eacute: 'é'
  }
  const src = String(text ?? '')
  const pattern = /&#x([0-9a-fA-F]+);|&#([0-9]+);|&([a-zA-Z]+);/g
  const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
  const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff
  /** 合法且安全的码点：排除 0、超出 Unicode、代理项区间、C0/C1 控制字符（保留 \t \n \r）。 */
  const valid = (c: number) =>
    Number.isFinite(c) &&
    c > 0 &&
    c <= 0x10ffff &&
    !(c >= 0xd800 && c <= 0xdfff) &&
    !((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f))
  let out = ''
  let last = 0
  let pendingHigh = 0
  let pendingEnd = -1
  let m: RegExpExecArray | null
  while ((m = pattern.exec(src)) !== null) {
    // 高代理项与低代理项实体之间若夹着别的文本，就不是一对 → 直接丢掉
    if (pendingHigh && m.index !== pendingEnd) pendingHigh = 0
    const code = m[1] !== undefined ? Number.parseInt(m[1], 16) : m[2] !== undefined ? Number.parseInt(m[2], 10) : NaN
    if (Number.isNaN(code)) {
      out += src.slice(last, m.index) + (named[m[3].toLowerCase()] ?? m[0])
    } else if (isHigh(code)) {
      out += src.slice(last, m.index)
      pendingHigh = code
      pendingEnd = m.index + m[0].length
      last = pendingEnd
      continue
    } else if (isLow(code) && pendingHigh) {
      out += String.fromCodePoint((pendingHigh - 0xd800) * 0x400 + (code - 0xdc00) + 0x10000)
      pendingHigh = 0
    } else if (isLow(code) || !valid(code)) {
      out += src.slice(last, m.index) // 落单的代理项 / 非法码点 → 丢弃
    } else {
      out += src.slice(last, m.index) + String.fromCodePoint(code)
    }
    pendingHigh = 0
    last = m.index + m[0].length
  }
  return out + src.slice(last)
}

const HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g
const LOW_SURROGATE = /(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

/**
 * 模型输入安全化：去掉「孤立 UTF-16 代理项」与非法控制字符。
 * 真机回归：按字符数截断可能把 emoji 截成半个代理项，JSON 序列化后成为非法转义，
 * 服务端直接 400（"Failed to parse the request body as JSON: unexpected end of hex escape"）。
 */
export function sanitizeForModel(text: string | null | undefined): string {
  return String(text ?? '')
    .replace(HIGH_SURROGATE, '')
    .replace(LOW_SURROGATE, '$1')
    .replace(CONTROL_CHARS, ' ')
}

/** 按字符数安全截断：不切断代理对（emoji），截断处补省略号。 */
export function truncateSafe(text: string | null | undefined, maxChars: number): string {
  const t = sanitizeForModel(text)
  if (t.length <= maxChars) return t
  let cut = t.slice(0, maxChars)
  const last = cut.charCodeAt(cut.length - 1)
  // 末位是高代理项 → 正好切在代理对中间，去掉它
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut}…`
}

/** 折叠空白：连续空格→单空格，行首尾空格去掉，多空行→单换行。 */
function collapseWhitespace(s: string): string {
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** HTML → 纯文本（去 style/script/标签、解实体、块级标签转换为换行）。 */
export function plainFromHtml(html: string | null | undefined, maxChars = 20000): string {
  if (!html) return ''
  const stripped = String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return truncateSafe(collapseWhitespace(decodeEntities(stripped)), maxChars)
}

/** 去掉 CSS/JS 噪声（含 <style> 块、@media/@import、选择器规则块、注释）。 */
export function stripCssNoise(text: string | null | undefined): string {
  if (!text) return ''
  const stripped = String(text)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/@(?:import|charset|media|font-face|keyframes|supports)[^;{]*[;{]/gi, ' ')
    .replace(/[#.@a-zA-Z0-9_\-[\]="'>:\s,]{1,160}\{[^{}]{0,3000}\}/g, ' ')
  return sanitizeForModel(collapseWhitespace(decodeEntities(stripped)))
}

/** 判断文本是否「CSS 味」很重（用于决定是否改用 HTML 版本重新转文本）。 */
export function isCssHeavy(text: string | null | undefined): boolean {
  const t = String(text ?? '')
  if (!t) return false
  const rules = (t.match(/\{[^{}]{0,600}\}/g) ?? []).length
  const hints = (t.match(/@media|@import|!important|font-family\s*:|max-width\s*:|padding\s*:|border-radius\s*:/gi) ?? [])
    .length
  return rules >= 3 || hints >= 5
}

/**
 * 邮件正文清洗：优先用干净文本；若纯文本里混着 CSS（mailparser 对 HTML 邮件的常见行为），
 * 且有 HTML 版本可用，则改用 HTML→纯文本的结果。
 * 注意：短而正常的正文必须原样保留，不能被 HTML 版本覆盖（否则「纯文本部分」会被换成 HTML 内容）。
 */
export function cleanMailText(text: string | null | undefined, html?: string | null): string {
  const raw = sanitizeForModel(String(text ?? '')).trim()
  const stripped = stripCssNoise(raw)
  const htmlText = html ? plainFromHtml(html) : ''
  const noisy = isCssHeavy(raw) || (raw.length > 200 && raw.length - stripped.length > raw.length * 0.3)
  if (noisy && htmlText.length > 0) {
    return htmlText.length >= stripped.length ? htmlText : stripped
  }
  return stripped.length > 0 ? stripped : htmlText
}

/** 给 AI 的日期文本：本地时区（Asia/Hong_Kong）并显式标注；未知时明确写「未知」。 */
export function formatPromptDate(ts: number): string {
  if (!ts || ts <= 0) return '未知'
  try {
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Hong_Kong',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
    return `${fmt.format(new Date(ts)).replace(/\//g, '-')}（北京时间）`
  } catch {
    return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
  }
}

/**
 * 轻量 Markdown 渲染（无第三方依赖，纯函数、可单测）：
 * 支持标题、表格、有序/无序列表、任务清单、引用、粗体/斜体/行内代码、链接、分割线。
 * 安全策略：**先转义 HTML**，再生成标签；链接只允许 http/https。
 * 调用方（详情页）仍会再过一遍 DOMPurify 作为第二道防线。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内元素：粗体、斜体、行内代码、链接（先转义再替换）。 */
export function renderInline(raw: string): string {
  let s = escapeHtml(raw)
  // 行内代码 `code`（其中不再做其它替换）
  const codes: string[] = []
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  // 链接 [文字](url)：只允许 http/https，以及应用内的邮件锚点 #mail-<id>
  // （V2.2：AI 回答里的邮件名可点击，点了直接跳到那封邮件）
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/[^\s)]+)|(?:#mail-\d+))\)/g, (_m, text: string, url: string) => {
    return `<a href="${url}" rel="noreferrer noopener"${url.startsWith('#mail-') ? ' class="cite-link"' : ''}>${text}</a>`
  })
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '')
  return s
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-')
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

/** Markdown → 安全 HTML 字符串。 */
export function renderMarkdown(markdown: string | null | undefined): string {
  const text = String(markdown ?? '').replace(/\r\n?/g, '\n')
  if (!text.trim()) return ''
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0

  const flushParagraph = (buf: string[]): void => {
    if (buf.length === 0) return
    out.push(`<p>${buf.map((l) => renderInline(l.trim())).join('<br>')}</p>`)
    buf.length = 0
  }
  const paragraph: string[] = []

  while (i < lines.length) {
    const line = lines[i]

    // 空行
    if (!line.trim()) {
      flushParagraph(paragraph)
      i += 1
      continue
    }

    // 分割线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph(paragraph)
      out.push('<hr>')
      i += 1
      continue
    }

    // 标题
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph(paragraph)
      const level = Math.min(2 + heading[1].length, 6) // h1→h3，避免抢页面标题层级
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`)
      i += 1
      continue
    }

    // 表格（表头 + 分隔行）
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph(paragraph)
      const header = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]))
        i += 1
      }
      const thead = `<thead><tr>${header.map((h) => `<th>${renderInline(h)}</th>`).join('')}</tr></thead>`
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${header.map((_h, idx) => `<td>${renderInline(r[idx] ?? '')}</td>`).join('')}</tr>`)
        .join('')}</tbody>`
      // 表格外面包一层可横向滚动的容器：窄侧栏下也不会把文字裁掉
      out.push(`<div class="md-table-wrap"><table>${thead}${tbody}</table></div>`)
      continue
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(paragraph)
      const buf: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      out.push(`<blockquote>${buf.map((l) => renderInline(l.trim())).join('<br>')}</blockquote>`)
      continue
    }

    // 列表（有序 / 无序 / 任务清单）
    const listMatch = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (listMatch) {
      flushParagraph(paragraph)
      const ordered = /\d+\./.test(listMatch[1])
      const items: string[] = []
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[i])
        if (!m) break
        let item = m[2]
        const task = /^\[( |x|X)\]\s*(.*)$/.exec(item)
        if (task) {
          const done = task[1].toLowerCase() === 'x'
          item = `${done ? '☑' : '☐'} ${task[2]}`
        }
        items.push(`<li>${renderInline(item)}</li>`)
        i += 1
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.join('')}</${tag}>`)
      continue
    }

    paragraph.push(line)
    i += 1
  }
  flushParagraph(paragraph)
  return out.join('\n')
}

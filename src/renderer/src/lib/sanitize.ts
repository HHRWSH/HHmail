/**
 * HTML 正文净化（规范 §2 第 10 条）：
 * - DOMPurify 白名单净化，剥离 script/事件属性/iframe/object/javascript: 链接；
 * - 图片策略由设置项「显示邮件图片」决定（真机反馈：以前一律剥掉所有 <img>，
 *   结果图片型邮件（newsletter）打开是一片空白）。
 *   - allowRemoteImages=false：只剥掉**远程** http(s) 图片（防跟踪像素），
 *     内嵌的 data: / cid: 图片属于邮件自身内容，一律保留；
 *   - allowRemoteImages=true（默认）：连远程图片一起显示。
 */
import DOMPurify from 'dompurify'

export interface SanitizeOptions {
  allowRemoteImages?: boolean
}

type SanitizeConfig = NonNullable<Parameters<typeof DOMPurify.sanitize>[1]>

export function sanitizeHtml(html: string, opts: SanitizeOptions = {}): string {
  const config: SanitizeConfig = {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta'],
    FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'srcdoc']
  }
  let clean = String(DOMPurify.sanitize(html, config))
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? ''
    const remote = /^https?:/i.test(src)
    // 只允许这三种协议；其它（含相对路径、javascript:）一律移除
    if (!/^(https?:|data:|cid:)/i.test(src)) {
      img.remove()
      return
    }
    if (remote && !opts.allowRemoteImages) img.remove()
  })
  clean = doc.body.innerHTML
  return clean
}

/** 链接净化：邮件里的 <a href> 必须保持 http(s)，其余剥掉。 */
export function sanitizeLink(href: string): string {
  return /^https?:\/\//i.test(href) ? href : '#'
}

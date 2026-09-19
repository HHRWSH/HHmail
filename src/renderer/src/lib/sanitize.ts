/**
 * HTML 正文净化（规范 §2 第 10 条）：
 * - DOMPurify 白名单净化，剥离 script/事件属性/iframe/object/javascript: 链接；
 * - 默认不加载远程图片（防跟踪像素）：allowRemoteImages=false 时移除 <img>；
 * - 用户显式点击「加载图片」后才放行远程图片。
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
  if (!opts.allowRemoteImages) {
    // 移除所有 img（包含 data:/cid: 的一并移除，保持"默认不加载图片"的语义）
    doc.querySelectorAll('img').forEach((img) => img.remove())
  } else {
    // 放行图片但强制去事件属性，且仅允许 http(s)/data:/cid: 协议
    doc.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') ?? ''
      if (!/^(https?:|data:|cid:)/i.test(src)) img.remove()
    })
  }
  clean = doc.body.innerHTML
  return clean
}

/** 链接净化：邮件里的 <a href> 必须保持 http(s)，其余剥掉。 */
export function sanitizeLink(href: string): string {
  return /^https?:\/\//i.test(href) ? href : '#'
}

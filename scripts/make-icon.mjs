// 生成应用图标（无第三方依赖，纯 Node）：资源 → resources/icon.ico + src/main/trayIcon.ts
//
// 为什么要有这个脚本：V2.2 通用化后不能再带任何学校元素（原标题图标是一个 "C" 字母），
// 于是用代码画一个中性的「信封 + AI 星芒」图标，保证可复现、可随时改配色。
//
// 用法：node scripts/make-icon.mjs
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const BG_FROM = [10, 132, 255] // 蓝
const BG_TO = [94, 92, 230] // 靛
const PAPER = [255, 255, 255]
const SPARK = [255, 209, 102] // 暖黄（AI）

/** 4 点星芒（AI 提示）判定：中心在 (cx,cy)，半径 r，腰身比例 k。 */
function inSpark(x, y, cx, cy, r, k) {
  const dx = Math.abs(x - cx)
  const dy = Math.abs(y - cy)
  // 两条「细长菱形」的并集
  const a = dx / r + dy / (r * k) <= 1
  const b = dy / r + dx / (r * k) <= 1
  return a || b
}

/** 圆角矩形：返回 0..1 覆盖率由超采样决定。 */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/** 点到线段的距离（画信封的 V 形封口）。 */
function distToSegment(px, py, x0, y0, x1, y1) {
  const vx = x1 - x0
  const vy = y1 - y0
  const wx = px - x0
  const wy = py - y0
  const len2 = vx * vx + vy * vy || 1
  const t = Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2))
  const dx = px - (x0 + t * vx)
  const dy = py - (y0 + t * vy)
  return Math.hypot(dx, dy)
}

/** 渲染一张 size×size 的 RGBA 图（内部 4× 超采样抗锯齿）。 */
function render(size) {
  const SS = 4
  const out = Buffer.alloc(size * size * 4)
  const s = size
  for (let py = 0; py < s; py += 1) {
    for (let px = 0; px < s; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = ((px + (sx + 0.5) / SS) / s) * 100
          const y = ((py + (sy + 0.5) / SS) / s) * 100

          // 1) 圆角方形底：对角渐变
          if (!inRoundRect(x, y, 3, 3, 97, 97, 22)) continue
          const t = Math.min(1, Math.max(0, (x + y) / 200))
          let cr = BG_FROM[0] + (BG_TO[0] - BG_FROM[0]) * t
          let cg = BG_FROM[1] + (BG_TO[1] - BG_FROM[1]) * t
          let cb = BG_FROM[2] + (BG_TO[2] - BG_FROM[2]) * t

          // 2) 信封：白色圆角矩形 + 背景色 V 形封口
          const inBody = inRoundRect(x, y, 18, 30, 82, 72, 6)
          // 封口两条斜线（左上→中心、中心→右上）
          const flap =
            distToSegment(x, y, 19, 31, 50, 55) < 4.2 || distToSegment(x, y, 50, 55, 81, 31) < 4.2
          // 信封左右两条竖边（让 V 与边框连成一体）
          const sideEdge = distToSegment(x, y, 20, 34, 20, 70) < 3.4 || distToSegment(x, y, 80, 34, 80, 70) < 3.4

          if (inBody) {
            const isLine = (flap || sideEdge) && !inSpark(x, y, 76, 26, 15, 0.3)
            // 上半部分画 V；下半部分保持白纸
            if (isLine && y < 58) {
              cr = BG_FROM[0] + (BG_TO[0] - BG_FROM[0]) * t
              cg = BG_FROM[1] + (BG_TO[1] - BG_FROM[1]) * t
              cb = BG_FROM[2] + (BG_TO[2] - BG_FROM[2]) * t
            } else {
              cr = PAPER[0]
              cg = PAPER[1]
              cb = PAPER[2]
            }
          }

          // 3) AI 星芒（右上角，压在信封边缘上）
          if (inSpark(x, y, 76, 26, 15, 0.3)) {
            cr = SPARK[0]
            cg = SPARK[1]
            cb = SPARK[2]
          }

          r += cr
          g += cg
          b += cb
          a += 255
        }
      }
      const n = SS * SS
      const i = (py * s + px) * 4
      const cov = a / n
      const alpha = cov / 255
      out[i] = alpha > 0 ? Math.round(r / n / alpha) : 0
      out[i + 1] = alpha > 0 ? Math.round(g / n / alpha) : 0
      out[i + 2] = alpha > 0 ? Math.round(b / n / alpha) : 0
      out[i + 3] = Math.round(cov)
    }
  }
  return out
}

/** 最小 PNG 编码器（RGBA，无滤波）。 */
function encodePng(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const crcTable = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()
  const crc32 = (buf) => {
    let c = -1
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const typeBuf = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
    return Buffer.concat([len, typeBuf, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** ICO：每个尺寸一条 BMP 记录（BITMAPINFOHEADER + BGRA 倒序 + 空 AND 掩码）。 */
function encodeIco(images) {
  const entries = []
  const blobs = []
  let offset = 6 + images.length * 16
  for (const { size, rgba } of images) {
    const header = Buffer.alloc(40)
    header.writeUInt32LE(40, 0)
    header.writeInt32LE(size, 4)
    header.writeInt32LE(size * 2, 8) // XOR + AND
    header.writeUInt16LE(1, 12)
    header.writeUInt16LE(32, 14)
    const pixels = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y += 1) {
      const src = (size - 1 - y) * size * 4
      for (let x = 0; x < size; x += 1) {
        const i = src + x * 4
        const o = (y * size + x) * 4
        pixels[o] = rgba[i + 2] // B
        pixels[o + 1] = rgba[i + 1] // G
        pixels[o + 2] = rgba[i] // R
        pixels[o + 3] = rgba[i + 3] // A
      }
    }
    const mask = Buffer.alloc((size * size) / 8) // 全 0 = 全不透明由 alpha 决定
    const blob = Buffer.concat([header, pixels, mask])
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(blob.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    blobs.push(blob)
    offset += blob.length
  }
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  return Buffer.concat([head, ...entries, ...blobs])
}

const SIZES = [256, 128, 64, 48, 32, 16]
const rendered = SIZES.map((size) => ({ size, rgba: render(size) }))
fs.writeFileSync(path.join(ROOT, 'resources', 'icon.ico'), encodeIco(rendered))
// 1024×1024 PNG：macOS 打包（electron-builder 会自动转成 .icns）需要 ≥512，这里给 1024 最清晰
const icon1024 = render(1024)
fs.writeFileSync(path.join(ROOT, 'resources', 'icon.png'), encodePng(icon1024, 1024))

const tray = render(32)
const trayB64 = encodePng(tray, 32).toString('base64')
const ts = `/**
 * 托盘图标（由 scripts/make-icon.mjs 生成，勿手改）：
 * 32×32 PNG 的 base64 data URL，避免打包时的资源路径问题。
 */
export const TRAY_ICON_DATA_URL =\n  'data:image/png;base64,${trayB64}'\n`
fs.writeFileSync(path.join(ROOT, 'src', 'main', 'trayIcon.ts'), ts)

console.log(`✅ 图标已生成：resources/icon.ico（${SIZES.join('/')}）、resources/icon.png、src/main/trayIcon.ts`)

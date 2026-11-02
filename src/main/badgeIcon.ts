/**
 * 任务栏未读角标的图标（运行时用代码画 PNG，避免资源文件打包路径问题 —— 与 trayIcon 同一思路）。
 *
 * 为什么自己画：角标需要 1–9 与「9+」共 10 张图，随包放 10 个 png 容易漏打包/路径错；
 * 这里用内置 5×7 点阵字体 + 简单 PNG 编码器（Node zlib）现场生成 data URL，
 * 纯 Node 实现 → 可以在单测里直接验证（不需要 Electron）。
 */
import * as zlib from 'node:zlib'
import { type UnreadBadgeKind, badgeText } from '../shared/unreadBadge'

/** 5×7 点阵字体（每行 5 位，1=亮） */
const GLYPHS: Record<string, number[]> = {
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  '+': [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000]
}

/** PNG 编码（RGBA8、无过滤行） */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0 // filter type 0
    for (let x = 0; x < width * 4; x += 1) {
      raw[y * (width * 4 + 1) + 1 + x] = rgba[y * width * 4 + x]
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const typeBuf = Buffer.from(type, 'ascii')
    const crcInput = Buffer.concat([typeBuf, data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(crcInput) >>> 0, 0)
    return Buffer.concat([len, typeBuf, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

let crcTable: number[] | null = null
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = []
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 画角标：圆底（未读红 #E5484D）+ 白色数字，2 倍超采样后缩到目标尺寸获得抗锯齿。
 * @param kind 角标种类（'1'..'9' / '9plus'）
 * @param size 输出尺寸（Windows 任务栏 overlay 用 32 足够清晰）
 */
export function renderBadgeRgba(kind: UnreadBadgeKind, size = 32): Uint8Array {
  const SS = 2 // 超采样倍数
  const w = size * SS
  const buf = new Uint8Array(w * w * 4)
  const cx = (w - 1) / 2
  const cy = (w - 1) / 2
  const r = w / 2 - SS // 圆半径（留 1px 边）
  const text = badgeText(kind)
  const scale = text.length > 1 ? 2 : 3 // 「9+」用小一号字
  const glyphW = 5 * scale
  const gap = scale
  const totalW = text.length * glyphW + (text.length - 1) * gap
  const totalH = 7 * scale
  const startX = Math.round((w - totalW) / 2)
  const startY = Math.round((w - totalH) / 2)

  const put = (x: number, y: number, rgba: [number, number, number, number]): void => {
    if (x < 0 || y < 0 || x >= w || y >= w) return
    const i = (y * w + x) * 4
    buf[i] = rgba[0]
    buf[i + 1] = rgba[1]
    buf[i + 2] = rgba[2]
    buf[i + 3] = rgba[3]
  }

  // 圆底
  for (let y = 0; y < w; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const d = Math.hypot(x - cx, y - cy)
      if (d <= r) put(x, y, [229, 72, 77, 255]) // #E5484D
    }
  }
  // 文字
  let cursor = startX
  for (const ch of text) {
    const glyph = GLYPHS[ch]
    if (glyph) {
      for (let gy = 0; gy < 7; gy += 1) {
        for (let gx = 0; gx < 5; gx += 1) {
          if ((glyph[gy]! >> (4 - gx)) & 1) {
            for (let sy = 0; sy < scale; sy += 1) {
              for (let sx = 0; sx < scale; sx += 1) {
                put(cursor + gx * scale + sx, startY + gy * scale + sy, [255, 255, 255, 255])
              }
            }
          }
        }
      }
    }
    cursor += glyphW + gap
  }

  // 下采样
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r0 = 0
      let g0 = 0
      let b0 = 0
      let a0 = 0
      for (let dy = 0; dy < SS; dy += 1) {
        for (let dx = 0; dx < SS; dx += 1) {
          const i = ((y * SS + dy) * w + (x * SS + dx)) * 4
          r0 += buf[i]!
          g0 += buf[i + 1]!
          b0 += buf[i + 2]!
          a0 += buf[i + 3]!
        }
      }
      const n = SS * SS
      const o = (y * size + x) * 4
      out[o] = Math.round(r0 / n)
      out[o + 1] = Math.round(g0 / n)
      out[o + 2] = Math.round(b0 / n)
      out[o + 3] = Math.round(a0 / n)
    }
  }
  return out
}

const cache = new Map<string, string>()

/** 角标 → data URL（带缓存；主进程在 nativeImage.createFromDataURL 里用） */
export function badgeIconDataUrl(kind: UnreadBadgeKind, size = 32): string {
  const key = `${kind}@${size}`
  const hit = cache.get(key)
  if (hit) return hit
  const png = encodePng(renderBadgeRgba(kind, size), size, size)
  const url = `data:image/png;base64,${png.toString('base64')}`
  cache.set(key, url)
  return url
}

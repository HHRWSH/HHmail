import { describe, expect, it } from 'vitest'
import {
  MAX_ATTACH_BYTES,
  MAX_ATTACH_COUNT,
  MAX_ATTACH_TOTAL_BYTES,
  formatAttachmentSize,
  mergeAttachments,
  totalAttachmentBytes
} from './attachments'
import type { MailAttachmentPayload } from './types'

const att = (filename: string, size: number): MailAttachmentPayload => ({
  filename,
  contentType: 'application/octet-stream',
  size,
  dataBase64: 'AA=='
})

describe('发信附件 —— 大小文案', () => {
  it('B / KB / MB 三档', () => {
    expect(formatAttachmentSize(0)).toBe('0 B')
    expect(formatAttachmentSize(512)).toBe('512 B')
    expect(formatAttachmentSize(2048)).toBe('2.0 KB')
    expect(formatAttachmentSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('非法输入不崩', () => {
    expect(formatAttachmentSize(Number.NaN)).toBe('-')
    expect(formatAttachmentSize(-5)).toBe('-')
  })
})

describe('发信附件 —— 合并与上限校验', () => {
  it('正常追加，并统计总大小', () => {
    const r = mergeAttachments([att('a.pdf', 100)], [att('b.jpg', 200)])
    expect(r.error).toBeNull()
    expect(r.list.map((x) => x.filename)).toEqual(['a.pdf', 'b.jpg'])
    expect(totalAttachmentBytes(r.list)).toBe(300)
  })

  it('同名同大小视为重复 → 跳过（不报错）', () => {
    const r = mergeAttachments([att('a.pdf', 100)], [att('a.pdf', 100)])
    expect(r.error).toBeNull()
    expect(r.list).toHaveLength(1)
  })

  it('同名但大小不同 → 当作两个附件', () => {
    const r = mergeAttachments([att('a.pdf', 100)], [att('a.pdf', 200)])
    expect(r.list).toHaveLength(2)
  })

  it('超过 10 个 → 停止添加并给中文提示，已接受的保留', () => {
    const prev = Array.from({ length: MAX_ATTACH_COUNT }, (_, i) => att(`f${i}.pdf`, 1))
    const r = mergeAttachments(prev, [att('overflow.pdf', 1)])
    expect(r.error).toContain(`${MAX_ATTACH_COUNT}`)
    expect(r.list).toHaveLength(MAX_ATTACH_COUNT)
  })

  it('单个文件超过 15MB → 拒绝并提示文件名', () => {
    const r = mergeAttachments([], [att('big.iso', MAX_ATTACH_BYTES + 1)])
    expect(r.error).toContain('big.iso')
    expect(r.error).toContain('15MB')
    expect(r.list).toHaveLength(0)
  })

  it('合计超过 20MB → 拒绝（前一个仍然保留）', () => {
    const half = Math.floor(MAX_ATTACH_TOTAL_BYTES / 2)
    // 各占一半会让合计正好等于上限（允许）→ 这里多 1 字节，确保真的超出
    const r = mergeAttachments([att('x.zip', half)], [att('y.zip', half + 1)])
    expect(r.error).toContain('20MB')
    expect(r.list.map((x) => x.filename)).toEqual(['x.zip'])
  })

  it('合计恰好等于 20MB → 允许（边界值不误杀）', () => {
    const half = Math.floor(MAX_ATTACH_TOTAL_BYTES / 2)
    const r = mergeAttachments([att('x.zip', half)], [att('y.zip', half)])
    expect(r.error).toBeNull()
    expect(r.list).toHaveLength(2)
    expect(totalAttachmentBytes(r.list)).toBe(MAX_ATTACH_TOTAL_BYTES)
  })

  it('恰好等于上限 → 允许（边界值不误杀）', () => {
    const r = mergeAttachments([], [att('exact.bin', MAX_ATTACH_BYTES)])
    expect(r.error).toBeNull()
    expect(r.list).toHaveLength(1)
  })
})

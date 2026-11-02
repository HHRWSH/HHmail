import { describe, expect, it } from 'vitest'
import { sendMailSchema } from './ipc-schemas'

/**
 * 发信附件的 zod 校验（V2.3）。
 * 单文件 ≤15MB（size 字段）、合计 ≤20MB、数量 ≤10、filename ≤200、严格模式拒绝未知字段。
 */
describe('发信附件 zod 校验', () => {
  const base = {
    to: 'a@x.com',
    subject: 's',
    body: 'b',
    attachments: [{ filename: '成绩单.pdf', contentType: 'application/pdf', size: 1024, dataBase64: 'AA==' }]
  }

  it('正常附件通过', () => {
    expect(sendMailSchema.safeParse(base).success).toBe(true)
  })

  it('不传附件也能过（向后兼容旧调用方）', () => {
    expect(sendMailSchema.safeParse({ to: 'a@x.com', subject: 's', body: 'b' }).success).toBe(true)
  })

  it('数量超过 10 个 → 拒绝', () => {
    const attachments = Array.from({ length: 11 }, (_, i) => ({
      filename: 'f' + i + '.pdf',
      contentType: 'application/pdf',
      size: 1,
      dataBase64: 'AA=='
    }))
    expect(sendMailSchema.safeParse({ ...base, attachments }).success).toBe(false)
  })

  it('单文件超过 15MB → 拒绝', () => {
    const attachments = [
      { filename: 'x.iso', contentType: 'application/octet-stream', size: 15 * 1024 * 1024 + 1, dataBase64: 'AA==' }
    ]
    expect(sendMailSchema.safeParse({ ...base, attachments }).success).toBe(false)
  })

  it('合计超过 20MB → 拒绝', () => {
    const each = 11 * 1024 * 1024
    const attachments = [
      { filename: 'a.bin', contentType: 'application/octet-stream', size: each, dataBase64: 'AA==' },
      { filename: 'b.bin', contentType: 'application/octet-stream', size: each, dataBase64: 'AA==' }
    ]
    expect(sendMailSchema.safeParse({ ...base, attachments }).success).toBe(false)
  })

  it('合计恰好 20MB → 允许（边界不误杀）', () => {
    const each = 10 * 1024 * 1024
    const attachments = [
      { filename: 'a.bin', contentType: 'application/octet-stream', size: each, dataBase64: 'AA==' },
      { filename: 'b.bin', contentType: 'application/octet-stream', size: each, dataBase64: 'AA==' }
    ]
    expect(sendMailSchema.safeParse({ ...base, attachments }).success).toBe(true)
  })

  it('文件名过长/空、contentType 空 → 拒绝', () => {
    const att = base.attachments[0]
    expect(sendMailSchema.safeParse({ ...base, attachments: [{ ...att, filename: 'x'.repeat(201) }] }).success).toBe(false)
    expect(sendMailSchema.safeParse({ ...base, attachments: [{ ...att, filename: '' }] }).success).toBe(false)
    expect(sendMailSchema.safeParse({ ...base, attachments: [{ ...att, contentType: '' }] }).success).toBe(false)
  })

  it('附件里夹带未知字段 → 拒绝（strict）', () => {
    expect(
      sendMailSchema.safeParse({ ...base, attachments: [{ ...base.attachments[0], evil: 1 }] }).success
    ).toBe(false)
  })
})

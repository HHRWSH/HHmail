import { describe, expect, it } from 'vitest'
import { buildTestEmail, FakeMailProvider, MOCK_EMAIL, MockAuthService } from './mock'
import { parseRawMessage } from './mail/mime'

describe('mock 模式自测数据（不依赖真实邮箱）', () => {
  it('buildTestEmail 生成的 EML 可被真实 mailparser 解析，正文不含原始邮件头', async () => {
    const raw = buildTestEmail(101, { subject: '关于毕业论文进度的沟通' })
    const msg = await parseRawMessage(raw, 101)
    expect(msg.subject).toBe('关于毕业论文进度的沟通')
    expect(msg.bodyText).toContain('邮箱助手自测')
    expect(msg.bodyText).not.toContain('MIME-Version')
    expect(msg.bodyText).not.toContain('Content-Transfer-Encoding')
    expect(msg.fromAddr).toBe('lin@example.edu')
  })

  it('带 References 的 EML 解析出引用链且不破坏正文', async () => {
    const raw = buildTestEmail(102, { refs: '<old@example.edu>', messageId: '<new@example.edu>' })
    const msg = await parseRawMessage(raw, 102)
    expect(msg.references).toEqual(['<old@example.edu>'])
    expect(msg.messageId).toBe('<new@example.edu>')
    expect(msg.bodyText).not.toContain('MIME-Version')
  })

  it('带附件的 multipart EML：正文与附件同时解析，附件带 partId（V2 M2）', async () => {
    const raw = buildTestEmail(103, { subject: '附件测试', attachment: { filename: 'att.txt', content: 'mock attachment content' } })
    const msg = await parseRawMessage(raw, 103)
    expect(msg.bodyText).toContain('邮箱助手自测')
    expect(msg.attachments).toHaveLength(1)
    expect(msg.attachments[0].filename).toBe('att.txt')
    expect(msg.attachments[0].partId).toBeTruthy()
    expect(msg.attachments[0].disposition).toBe('attachment')
  })

  it('FakeMailProvider 默认 20 封、uidNext 正确、fetchBody 按 uid 返回', async () => {
    const provider = FakeMailProvider.withDefaults(20)
    expect(provider.mailbox.exists).toBe(20)
    expect(provider.mailbox.uidNext).toBe(121)
    const body = await provider.fetchBody(101)
    expect(body?.uid).toBe(101)
    expect(await provider.fetchBody(999)).toBeNull()
    expect(provider.capabilities.readOnly).toBe(true)
  })

  it('MockAuthService 状态为已登录且邮箱为 mock 地址', async () => {
    const auth = new MockAuthService(() => undefined)
    const status = await auth.status()
    expect(status.loggedIn).toBe(true)
    expect(status.email).toBe(MOCK_EMAIL)
  })
})

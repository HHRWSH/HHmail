import { describe, expect, it } from 'vitest'
import {
  isAllowedUnsubscribeTarget,
  parseListUnsubscribe,
  parseMailto,
  parseUnsubscribe,
  unsubscribeButtonLabel,
  unsubscribeConfirmText
} from './unsubscribe'

describe('退订 —— 解析 List-Unsubscribe 头', () => {
  it('多个尖括号地址', () => {
    expect(parseListUnsubscribe('<mailto:u@x.com>, <https://x.com/unsub?id=1>')).toEqual([
      'mailto:u@x.com',
      'https://x.com/unsub?id=1'
    ])
  })

  it('单地址 / 空 / 非法', () => {
    expect(parseListUnsubscribe('<https://a.com/u>')).toEqual(['https://a.com/u'])
    expect(parseListUnsubscribe('')).toEqual([])
    expect(parseListUnsubscribe(null)).toEqual([])
  })

  it('兼容没有尖括号的裸地址', () => {
    expect(parseListUnsubscribe('https://a.com/u')).toEqual(['https://a.com/u'])
  })
})

describe('退订 —— 安全校验（只允许 https / mailto）', () => {
  it('允许 https 与 mailto', () => {
    expect(isAllowedUnsubscribeTarget('https://example.com/unsub')).toBe(true)
    expect(isAllowedUnsubscribeTarget('mailto:unsub@example.com?subject=unsub')).toBe(true)
  })

  it('拒绝 http / javascript / data / file / 相对路径 / 空', () => {
    expect(isAllowedUnsubscribeTarget('http://example.com/unsub')).toBe(false)
    expect(isAllowedUnsubscribeTarget('javascript:alert(1)')).toBe(false)
    expect(isAllowedUnsubscribeTarget('data:text/html,<script>')).toBe(false)
    expect(isAllowedUnsubscribeTarget('file:///C:/Windows/win.ini')).toBe(false)
    expect(isAllowedUnsubscribeTarget('/unsubscribe')).toBe(false)
    expect(isAllowedUnsubscribeTarget('')).toBe(false)
  })
})

describe('退订 —— mailto 参数解析', () => {
  it('解析 to/subject/body', () => {
    expect(parseMailto('mailto:unsub@x.com?subject=unsubscribe&body=please')).toEqual({
      to: 'unsub@x.com',
      subject: 'unsubscribe',
      body: 'please'
    })
  })

  it('无参数只有地址', () => {
    expect(parseMailto('mailto:unsub@x.com')).toEqual({ to: 'unsub@x.com', subject: undefined, body: undefined })
  })

  it('非法 mailto → null', () => {
    expect(parseMailto('https://x.com')).toBeNull()
    expect(parseMailto('mailto:not-an-address')).toBeNull()
  })
})

describe('退订 —— 方案分类（RFC 8058 优先级）', () => {
  it('https + List-Unsubscribe-Post: One-Click → one-click', () => {
    const info = parseUnsubscribe({
      listUnsubscribe: '<https://x.com/u>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click'
    })
    expect(info).toMatchObject({ kind: 'one-click', url: 'https://x.com/u' })
  })

  it('只有 https → https-get', () => {
    expect(parseUnsubscribe({ listUnsubscribe: '<https://x.com/u>' })).toMatchObject({ kind: 'https-get' })
  })

  it('只有 mailto → mailto', () => {
    expect(parseUnsubscribe({ listUnsubscribe: '<mailto:u@x.com>' })).toMatchObject({
      kind: 'mailto',
      mailto: { to: 'u@x.com' }
    })
  })

  it('https 与 mailto 同时存在 → 优先 https', () => {
    expect(parseUnsubscribe({ listUnsubscribe: '<mailto:u@x.com>, <https://x.com/u>' })).toMatchObject({
      kind: 'https-get',
      url: 'https://x.com/u'
    })
  })

  it('没有头 → none + 原因', () => {
    const info = parseUnsubscribe({})
    expect(info.kind).toBe('none')
    expect(info.reason).toContain('没有提供退订')
  })

  it('只有不安全的 http 地址 → none + 明确提示拒绝', () => {
    const info = parseUnsubscribe({ listUnsubscribe: '<http://x.com/u>' })
    expect(info.kind).toBe('none')
    expect(info.reason).toContain('不安全')
  })

  it('https GET 不因 Post 头缺失而升级为一键', () => {
    const info = parseUnsubscribe({ listUnsubscribe: '<https://x.com/u>', listUnsubscribePost: '' })
    expect(info.kind).toBe('https-get')
  })
})

describe('退订 —— 界面文案', () => {
  it('按钮文案按类型区分', () => {
    expect(unsubscribeButtonLabel({ kind: 'one-click', url: 'https://x' })).toBe('退订')
    expect(unsubscribeButtonLabel({ kind: 'https-get', url: 'https://x' })).toBe('退订（浏览器）')
    expect(unsubscribeButtonLabel({ kind: 'mailto', mailto: { to: 'u@x.com' } })).toBe('退订（发邮件）')
    expect(unsubscribeButtonLabel({ kind: 'none' })).toBeNull()
  })

  it('二次确认文案说明会发生什么', () => {
    expect(unsubscribeConfirmText({ kind: 'one-click', url: 'https://x' })).toContain('一键退订')
    expect(unsubscribeConfirmText({ kind: 'https-get', url: 'https://x' })).toContain('浏览器')
    expect(unsubscribeConfirmText({ kind: 'mailto', mailto: { to: 'u@x.com' } })).toContain('u@x.com')
  })
})

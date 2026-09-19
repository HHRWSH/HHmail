import { describe, expect, it } from 'vitest'
import { shortcutMap } from './shortcuts'

const none = { ctrl: false, meta: false, shift: false, alt: false }

describe('shortcutMap —— 快捷键映射纯函数（V2 M7，规范 §7.2）', () => {
  it('inbox：j/k 上下移动', () => {
    expect(shortcutMap('j', none, 'inbox')).toBe('next')
    expect(shortcutMap('k', none, 'inbox')).toBe('prev')
    expect(shortcutMap('j', none, 'detail')).toBe('none')
    expect(shortcutMap('k', none, 'detail')).toBe('none')
  })

  it('Enter 打开（两种上下文）', () => {
    expect(shortcutMap('Enter', none, 'inbox')).toBe('open')
    expect(shortcutMap('Enter', none, 'detail')).toBe('open')
  })

  it('s 星标 / l 加标签 / u 标未读 / a 归档', () => {
    expect(shortcutMap('s', none, 'inbox')).toBe('star')
    expect(shortcutMap('l', none, 'inbox')).toBe('label')
    expect(shortcutMap('u', none, 'inbox')).toBe('unread')
    expect(shortcutMap('a', none, 'inbox')).toBe('archive')
  })

  it('/ 聚焦搜索 / Esc 关闭', () => {
    expect(shortcutMap('/', none, 'inbox')).toBe('search')
    expect(shortcutMap('Escape', none, 'inbox')).toBe('close')
    expect(shortcutMap('Escape', none, 'detail')).toBe('close')
  })

  it('带 Ctrl/Cmd/Alt 修饰 → none（留给系统/多选）', () => {
    expect(shortcutMap('s', { ...none, ctrl: true }, 'inbox')).toBe('none')
    expect(shortcutMap('j', { ...none, meta: true }, 'inbox')).toBe('none')
    expect(shortcutMap('a', { ...none, alt: true }, 'inbox')).toBe('none')
    // Shift 不阻止（如大写字母仍映射）
    expect(shortcutMap('s', { ...none, shift: true }, 'inbox')).toBe('star')
  })

  it('其他键 → none', () => {
    expect(shortcutMap('x', none, 'inbox')).toBe('none')
    expect(shortcutMap('ArrowDown', none, 'inbox')).toBe('none')
  })
})

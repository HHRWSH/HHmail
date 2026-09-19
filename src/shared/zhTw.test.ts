import { describe, expect, it } from 'vitest'
import { hasCjk, toSimplified, toTraditional, zhVariants } from './zhTw'

describe('zhTw —— 简繁转换（检索用）', () => {
  it('简体查询词能转成语料里的繁体写法', () => {
    expect(toTraditional('图书馆')).toBe('圖書館')
    expect(toTraditional('学费')).toBe('學費')
    expect(toTraditional('选课')).toBe('選課')
    expect(toTraditional('讲座')).toBe('講座')
    expect(toTraditional('奖学金')).toBe('獎學金')
    expect(toTraditional('英语工作坊')).toBe('英語工作坊')
    expect(toTraditional('成绩单')).toBe('成績單')
  })

  it('繁体 → 简体（反向提问也要能命中简体语料）', () => {
    expect(toSimplified('圖書館')).toBe('图书馆')
    expect(toSimplified('選課')).toBe('选课')
  })

  it('英文与已是目标写法的文本原样保留', () => {
    expect(toTraditional('Blackboard 通知')).toBe('Blackboard 通知')
    expect(toTraditional('圖書館')).toBe('圖書館')
    expect(toSimplified('图书馆')).toBe('图书馆')
    expect(toTraditional('')).toBe('')
  })

  it('歧义字故意不按字转换（避免把「注意」转成「註意」）', () => {
    expect(toTraditional('注意')).toBe('注意')
    expect(toTraditional('里面')).toBe('里面')
    expect(toTraditional('平台')).toBe('平台')
    expect(toTraditional('回复')).toBe('回复')
  })

  it('zhVariants 返回原串 + 另一种写法并去重', () => {
    expect(zhVariants('学费')).toEqual(['学费', '學費'])
    expect(zhVariants('Blackboard')).toEqual(['Blackboard'])
    expect(zhVariants('圖書館')).toEqual(['圖書館', '图书馆'])
  })

  it('hasCjk 判断是否含中文', () => {
    expect(hasCjk('Library 101')).toBe(false)
    expect(hasCjk('图书馆')).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { CAPABILITY_BRIEF, classifyAsk, expandFollowUp } from './askIntent'

describe('classifyAsk —— 问题路由（真机回归：能力类问题被当成搜邮件）', () => {
  it('能力类问题：问助手自己能做什么/数据从哪来', () => {
    // 用户截图里的原句
    expect(classifyAsk('你现在能不能调用知识库')).toBe('capability')
    expect(classifyAsk('你能看到我的邮件吗？')).toBe('capability')
    expect(classifyAsk('你是什么')).toBe('capability')
    expect(classifyAsk('有什么功能')).toBe('capability')
    expect(classifyAsk('这个怎么用')).toBe('capability')
    expect(classifyAsk('你的数据来源是什么')).toBe('capability')
  })

  it('寒暄类', () => {
    expect(classifyAsk('你好')).toBe('smalltalk')
    expect(classifyAsk('hi')).toBe('smalltalk')
    expect(classifyAsk('谢谢！')).toBe('smalltalk')
  })

  it('真正的邮件问题走检索', () => {
    expect(classifyAsk('上周导师发了什么邮件？')).toBe('mail')
    expect(classifyAsk('这周有什么截止？')).toBe('mail')
    expect(classifyAsk('ENG1110B 有哪些截止')).toBe('mail')
    expect(classifyAsk('图书馆相关的邮件有哪些？')).toBe('mail')
  })

  it('带「你能…吗」但确实在问邮件内容 → 仍走检索（防误判成能力类）', () => {
    expect(classifyAsk('你能帮我查一下这周的截止时间吗')).toBe('mail')
    expect(classifyAsk('你能看看导师最近发的邮件吗？')).toBe('mail')
    expect(classifyAsk('你能找到 ENG1110B 的作业要求吗')).toBe('mail')
    // 「知识库里有什么奖学金」问的是邮件内容，不是问助手能力
    expect(classifyAsk('知识库里有什么奖学金可以申请？')).toBe('mail')
  })

  it('问助手自身/功能名词的元问题 → 能力类', () => {
    expect(classifyAsk('什么是检索索引卡片')).toBe('capability')
    expect(classifyAsk('你能查一下我的邮件吗')).toBe('capability')
  })

  it('长问句里含「知识库」等词时仍按邮件问题处理（避免误判）', () => {
    const q = '请根据知识库里关于 ENG1110B 这门课的所有邮件，把每一次作业的截止时间、提交方式以及是否有补交政策都整理成表格给我'
    expect(classifyAsk(q)).toBe('mail')
  })

  it('能力说明包含数据范围与限制（供模型如实回答，不编造）', () => {
    expect(CAPABILITY_BRIEF).toContain('本地邮件库')
    expect(CAPABILITY_BRIEF).toContain('知识库集合')
    expect(CAPABILITY_BRIEF).toContain('不会发信')
    expect(CAPABILITY_BRIEF).toContain('不编造')
  })
})

describe('expandFollowUp —— 多轮指代追问补检索词', () => {
  it('指代型追问：拼上上一轮问题', () => {
    expect(expandFollowUp('那截止呢？', 'ENG1110B 的实验怎么交')).toContain('ENG1110B')
    expect(expandFollowUp('这封邮件说了什么', '关于奖学金的邮件')).toContain('奖学金')
  })

  it('独立问题不拼接；没有上一轮也不拼接', () => {
    expect(expandFollowUp('这周有什么截止？', '上一轮问题')).toBe('这周有什么截止？')
    expect(expandFollowUp('那截止呢？', null)).toBe('那截止呢？')
    // 长问句即使含指代词也算独立问题
    const long = '这个学期我需要完成哪些课程的作业以及它们的截止时间分别是什么时候'
    expect(expandFollowUp(long, '旧问题')).toBe(long)
  })
})

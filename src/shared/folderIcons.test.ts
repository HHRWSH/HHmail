import { describe, expect, it } from 'vitest'
import { COMMON_FOLDER_KINDS, folderIcon, folderKind, isCommonFolder } from './folderIcons'

describe('文件夹图标与常用性（V2.2：Outlook 风格侧边栏）', () => {
  it('按名字识别常见文件夹', () => {
    expect(folderKind('Inbox')).toBe('inbox')
    expect(folderKind('收件箱')).toBe('inbox')
    expect(folderKind('Drafts')).toBe('drafts')
    expect(folderKind('草稿')).toBe('drafts')
    expect(folderKind('Sent Items')).toBe('sent')
    expect(folderKind('已发送邮件')).toBe('sent')
    expect(folderKind('Deleted Items')).toBe('deleted')
    expect(folderKind('Junk Email')).toBe('junk')
    expect(folderKind('Archive')).toBe('archive')
    expect(folderKind('Conversation History')).toBe('conversation')
    expect(folderKind('Notes')).toBe('notes')
  })

  it('路径也能识别（取末段）', () => {
    expect(folderKind('INBOX/Drafts')).toBe('drafts')
    expect(folderKind('已删除邮件/垃圾邮件')).toBe('junk')
  })

  it('每个类别都有图标，未知文件夹回落 📁', () => {
    for (const kind of COMMON_FOLDER_KINDS) {
      expect(folderIcon(kind)).toBeTruthy()
    }
    expect(folderIcon('某个自定义文件夹')).toBe('📁')
    expect(folderIcon('')).toBe('📁')
  })

  it('常用文件夹判定：常用为 true、少用为 false（侧边栏据此折叠）', () => {
    expect(isCommonFolder('收件箱')).toBe(true)
    expect(isCommonFolder('已发送邮件')).toBe(true)
    expect(isCommonFolder('对话历史记录')).toBe(false)
    expect(isCommonFolder('搜索文件夹')).toBe(false)
    expect(isCommonFolder('联机存档 - HONG')).toBe(false)
  })
})

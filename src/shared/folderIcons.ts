/**
 * 文件夹图标与「常用文件夹」判定（V2.2：像 Outlook 那样给每个文件夹配图标）。
 * 纯函数：给名字/路径 → { icon, kind }，主进程与渲染进程都能用（也便于单测）。
 */

export type FolderKind =
  | 'inbox'
  | 'drafts'
  | 'sent'
  | 'deleted'
  | 'junk'
  | 'archive'
  | 'conversation'
  | 'notes'
  | 'outbox'
  | 'search'
  | 'other'

const ICONS: Record<FolderKind, string> = {
  inbox: '📥',
  drafts: '📝',
  sent: '📤',
  deleted: '🗑️',
  junk: '🚫',
  archive: '📦',
  conversation: '💬',
  notes: '🗒️',
  outbox: '📮',
  search: '🔍',
  other: '📁'
}

/** 常用文件夹（默认显示；其余的收进「更多文件夹」里，避免侧边栏太长） */
export const COMMON_FOLDER_KINDS: readonly FolderKind[] = ['inbox', 'drafts', 'sent', 'deleted', 'junk', 'archive']

const RULES: Array<{ kind: FolderKind; re: RegExp }> = [
  { kind: 'inbox', re: /^(inbox|收件箱)$/i },
  { kind: 'drafts', re: /^(drafts?|草稿|草稿箱)$/i },
  { kind: 'sent', re: /^(sent( items| mail| messages)?|已发送(邮件)?|发件箱)$/i },
  { kind: 'deleted', re: /^(deleted( items| messages)?|trash|已删除(邮件)?|废件箱)$/i },
  { kind: 'junk', re: /^(junk( e-?mail)?|spam|垃圾邮件|垃圾箱)$/i },
  { kind: 'archive', re: /^(archive|archives|存档|归档)$/i },
  { kind: 'conversation', re: /(conversation history|对话历史)/i },
  { kind: 'notes', re: /^(notes?|注释|便笺)$/i },
  { kind: 'outbox', re: /^(outbox|发件箱)$/i },
  { kind: 'search', re: /(search folders?|搜索文件夹)/i }
]

/** 识别文件夹类型（先按名字，再按路径末段）。 */
export function folderKind(nameOrPath: string): FolderKind {
  const raw = String(nameOrPath ?? '').trim()
  if (!raw) return 'other'
  const last = raw.split(/[/\\]/).filter(Boolean).pop() ?? raw
  for (const r of RULES) {
    if (r.re.test(raw) || r.re.test(last)) return r.kind
  }
  return 'other'
}

export function folderIcon(nameOrPath: string): string {
  return ICONS[folderKind(nameOrPath)]
}

/** 是否属于「常用文件夹」（不常用的会折叠到「更多文件夹」） */
export function isCommonFolder(nameOrPath: string): boolean {
  return COMMON_FOLDER_KINDS.includes(folderKind(nameOrPath))
}

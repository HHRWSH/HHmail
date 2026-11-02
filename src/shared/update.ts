/**
 * 自动更新（V2.3）—— 纯逻辑部分：版本比较、portable 判定、状态文案。
 *
 * 为什么单独抽出来：electron-updater 只能在 Electron 里跑，单元测试拿不到；
 * 版本比较/是否可更新/文案这些「决策」写成纯函数，就能用单测覆盖（含 9+ 数字比较、预发布等边界）。
 *
 * 版本规则：`MAJOR.MINOR.PATCH`，可带预发布后缀（`-beta.1`）。比较时：
 *   - 数字段逐段比；缺省补 0；
 *   - 有预发布后缀的**小于**同版本号正式版（semver 语义）；
 *   - 无法解析的版本按「不更新」处理，避免误升级。
 */

/** 解析版本 → { nums, prerelease }；非法返回 null */
export function parseVersion(raw: string): { nums: number[]; prerelease: string | null } | null {
  const text = String(raw ?? '')
    .trim()
    .replace(/^v/i, '')
  const m = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (!m) return null
  const nums = m[1].split('.').map((n) => Number.parseInt(n, 10))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  return { nums, prerelease: m[2] ?? null }
}

/** 比较两个版本：a>b → 1；a<b → -1；相等 → 0；无法解析 → 0（调用方按"不更新"处理） */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa.nums[i] ?? 0
    const y = pb.nums[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  // 数字相同 → 有预发布后缀的更小
  if (pa.prerelease && !pb.prerelease) return -1
  if (!pa.prerelease && pb.prerelease) return 1
  if (pa.prerelease && pb.prerelease) {
    if (pa.prerelease === pb.prerelease) return 0
    return pa.prerelease > pb.prerelease ? 1 : -1
  }
  return 0
}

/** 最新版本是否比当前新（无法解析 → false，宁可不更新） */
export function isNewerVersion(current: string, latest: string): boolean {
  if (!parseVersion(current) || !parseVersion(latest)) return false
  return compareVersions(latest, current) > 0
}

/**
 * 是否是 portable（绿色免安装）版：electron-builder 的 portable target 会设置
 * `PORTABLE_EXECUTABLE_DIR` 环境变量；portable 版**不支持**自动更新（只能手动下载覆盖）。
 */
export function isPortableBuild(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): boolean {
  return Boolean(env.PORTABLE_EXECUTABLE_DIR && env.PORTABLE_EXECUTABLE_DIR.trim().length > 0)
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

/** 更新状态（主进程 → 渲染层；渲染层据此画设置页） */
export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  /** 检测到的新版本（available/downloading/downloaded 时存在） */
  latestVersion?: string
  /** 下载进度 0..100 */
  progress?: number
  /** 已下载/总大小（字节，可选） */
  transferred?: number
  total?: number
  /** 失败原因（已裁剪，不含敏感信息） */
  error?: string
  /** 更新说明（GitHub Release notes 摘要） */
  notes?: string
  /** 是否 portable 版（不支持自动更新，只能手动下载） */
  portable: boolean
  /** 最后一次检查时间（ms） */
  checkedAt?: number
}

/** 状态文案（设置页/托盘提示用） */
export function describeUpdateState(state: UpdateState): string {
  switch (state.status) {
    case 'checking':
      return '正在检查更新…'
    case 'available':
      return `发现新版本 ${state.latestVersion ?? ''}，可下载`
    case 'not-available':
      return `已是最新版本（${state.currentVersion}）`
    case 'downloading':
      return `正在下载 ${state.latestVersion ?? ''}（${Math.round(state.progress ?? 0)}%）`
    case 'downloaded':
      return `${state.latestVersion ?? '新版本'} 下载完成，重启即可安装`
    case 'error':
      return `检查更新失败${state.error ? `：${state.error}` : ''}`
    case 'unsupported':
      return '当前为便携版，自动更新不可用 —— 请手动下载新版'
    default:
      return state.portable ? `当前版本 ${state.currentVersion}（便携版不支持自动更新）` : `当前版本 ${state.currentVersion}`
  }
}

/** 界面上的主按钮：null = 不显示按钮 */
export function updatePrimaryAction(state: UpdateState): { kind: 'download' | 'install' | 'recheck' | null; label: string } {
  if (state.portable) return { kind: 'recheck', label: '检查更新（便携版需手动下载）' }
  if (state.status === 'available') return { kind: 'download', label: '下载更新' }
  if (state.status === 'downloading') return { kind: null, label: '下载中…' }
  if (state.status === 'downloaded') return { kind: 'install', label: '重启并安装' }
  return { kind: 'recheck', label: '检查更新' }
}

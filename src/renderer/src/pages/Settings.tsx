/**
 * 设置页（V2.2：目录式折叠 + 分类）。
 *
 * 结构：外观 / 同步与通知 / AI 总结与问答 / 发信 / 账户 / 关于与数据，
 * 每类可折叠（折叠状态本地持久化，默认全部展开，便于搜索与 E2E 断言）。
 * 新增可调项（都不影响既有功能，只影响体验）：
 *   主题（跟随系统/浅色/深色）、界面密度、品牌名与副标题、时间格式、列表加载条数、
 *   打开即本地已读、启动自动同步、AI 引用条数、发送前二次确认。
 */
import { memo, useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AppSettings, AuthStatus, ThemeMode, UiDensity } from '@shared/types'
import {
  DEFAULT_ASK_TOPK,
  DEFAULT_BRAND_NAME,
  DEFAULT_BRAND_SUBTITLE,
  DEFAULT_LIST_PAGE_SIZE,
  DEFAULT_SUMMARY_PROMPT
} from '@shared/defaults'
import { DEFAULT_TAG_VOCABULARY, normalizeTag, parseVocabulary } from '@shared/tags'
import type { MailCategory } from '@shared/types'
import { AI_PROVIDERS, defaultModelForProvider, providerModels, resolveAiProvider } from '@shared/aiProviders'
import { DENSITY_OPTIONS, THEME_OPTIONS } from '@shared/theme'
import { api } from '../bridge'
import { errorMessage } from '../lib/errors'
import { SummaryProgressBar } from '../components/SummaryProgressBar'

interface Props {
  auth: AuthStatus
  onToast: (message: string) => void
  /** 退出登录（改完发信权限后需要重新登录一次） */
  onLogout?: () => void
  /** App 已经加载好的设置（避免重复请求） */
  settings?: AppSettings
  /** 保存成功后回传最新设置 → App 立刻应用主题/密度/品牌名 */
  onSettingsChanged?: (settings: AppSettings) => void
}

/** 新建类别的可选颜色（Gmail 同款色系） */
const CATEGORY_COLORS = ['#1a73e8', '#188038', '#e8710a', '#8430ce', '#d93025', '#f9ab00', '#12b5cb', '#e52592']

const OPEN_STORAGE_KEY = 'mail-ai-settings-open'

const SECTIONS = [
  { id: 'appearance', icon: '🎨', title: '外观', hint: '主题 · 密度' },
  { id: 'sync', icon: '🔄', title: '同步', hint: '范围 · 通知' },
  { id: 'ai', icon: '✨', title: 'AI 与标签', hint: '模型 · 提示词' },
  { id: 'send', icon: '✉️', title: '发信', hint: '权限 · SMTP' },
  { id: 'account', icon: '👤', title: '账户', hint: '登录账号' },
  { id: 'about', icon: '🧰', title: '关于与数据', hint: '隐私 · 维护' }
] as const

function readOpen(): string {
  try {
    const raw = window.localStorage.getItem(OPEN_STORAGE_KEY)
    if (raw && SECTIONS.some((s) => s.id === raw)) return raw
  } catch {
    /* ignore */
  }
  return 'appearance'
}

export const SettingsPage = memo(function SettingsPage({
  auth,
  onToast,
  onLogout,
  settings: settingsProp,
  onSettingsChanged
}: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(settingsProp ?? null)
  /** V2.2 重新设计：左栏分类导航 + 右栏内容（一次只看一个分类，比折叠更清晰） */
  const [active, setActive] = useState<string>(() => readOpen())
  const [model, setModel] = useState('deepseek-flash')
  const [providerId, setProviderId] = useState('deepseek')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [syncWindow, setSyncWindow] = useState('0')
  const [refreshSec, setRefreshSec] = useState('300')
  const [summaryPrompt, setSummaryPrompt] = useState(DEFAULT_SUMMARY_PROMPT)
  const [autoSummarizeNew, setAutoSummarizeNew] = useState(true)
  const [saving, setSaving] = useState(false)
  // V2.2 外观 / 行为
  const [theme, setTheme] = useState<ThemeMode>('system')
  const [density, setDensity] = useState<UiDensity>('standard')
  const [brandName, setBrandName] = useState(DEFAULT_BRAND_NAME)
  const [brandSubtitle, setBrandSubtitle] = useState(DEFAULT_BRAND_SUBTITLE)
  const [listPageSize, setListPageSize] = useState(String(DEFAULT_LIST_PAGE_SIZE))
  const [relativeTime, setRelativeTime] = useState(true)
  const [openMailMarksRead, setOpenMailMarksRead] = useState(true)
  const [syncOnStartup, setSyncOnStartup] = useState(false)
  const [confirmBeforeSend, setConfirmBeforeSend] = useState(false)
  const [askTopK, setAskTopK] = useState(String(DEFAULT_ASK_TOPK))
  // V2.1：修复同步 / 批量总结
  const [repairing, setRepairing] = useState(false)
  const [summarizingAll, setSummarizingAll] = useState(false)
  // M1：检索索引卡片覆盖情况（给 AI 检索用的第二份产物）
  const [indexStats, setIndexStats] = useState<{ total: number; missing: number } | null>(null)
  // 发送能力自检（只检测、不发送邮件）
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<string | null>(null)
  // 个人邮箱发信测试（真的发一封测试邮件；密码只走加密存储，不回显）
  const [smtpHost, setSmtpHost] = useState('smtp.gmail.com')
  const [smtpPort, setSmtpPort] = useState('587')
  const [smtpSecure, setSmtpSecure] = useState(false)
  const [smtpUser, setSmtpUser] = useState('')
  const [smtpPass, setSmtpPass] = useState('')
  const [smtpTo, setSmtpTo] = useState('')
  const [sendingTest, setSendingTest] = useState(false)
  const [sendResult, setSendResult] = useState<string | null>(null)
  // 学校账号发信（OAuth SMTP.Send）+ 发信权限开关
  const [sendScope, setSendScope] = useState(true)
  const [sendingSchool, setSendingSchool] = useState(false)
  const [schoolSendResult, setSchoolSendResult] = useState<string | null>(null)
  const [dataDir, setDataDir] = useState<string | null>(null)
  const [attachmentDir, setAttachmentDir] = useState('')
  // V2.2 自动标签
  const [autoTagEnabled, setAutoTagEnabled] = useState(true)
  const [tagVocabulary, setTagVocabulary] = useState('')
  const [tagVocabList, setTagVocabList] = useState<string[]>([...DEFAULT_TAG_VOCABULARY])
  const [tagVocabDraft, setTagVocabDraft] = useState('')
  const [tagExamples, setTagExamples] = useState<Array<{ id: number; subject: string; tags: string[] }>>([])
  const [tagCounts, setTagCounts] = useState<Array<{ tag: string; count: number }>>([])
  // V2.2：彩色类别（Gmail 风格）的管理放在设置里（详情页只负责选）
  const [categories, setCategories] = useState<MailCategory[]>([])
  const [newCatName, setNewCatName] = useState('')
  const [newCatColor, setNewCatColor] = useState('#1a73e8')
  const [showAllVocab, setShowAllVocab] = useState(false)
  const [rebuildingTags, setRebuildingTags] = useState(false)

  const selectSection = useCallback((id: string) => {
    setActive(id)
    try {
      window.localStorage.setItem(OPEN_STORAGE_KEY, id)
    } catch {
      /* ignore */
    }
  }, [])

  const repairSync = useCallback(async () => {
    if (repairing) return
    setRepairing(true)
    try {
      await api.resyncMail('INBOX')
      await api.syncMail({ folders: ['INBOX'] })
      onToast('已重新拉取收件箱缺失的邮件')
    } catch (e) {
      onToast(errorMessage(e))
    } finally {
      setRepairing(false)
    }
  }, [repairing, onToast])

  const summarizeAll = useCallback(
    async (force = false) => {
      if (summarizingAll) return
      setSummarizingAll(true)
      try {
        const res = await api.summarizePending(500, force)
        onToast(
          res.cancelled
            ? `已停止：本次完成 ${res.done} 封`
            : res.total === 0
              ? '所有邮件都已经有摘要了 ✅'
              : `已总结 ${res.done} 封${res.degraded > 0 ? `，${res.degraded} 封降级为元信息` : ''}${res.failed > 0 ? `，${res.failed} 封失败` : ''}`
        )
      } catch (e) {
        onToast(errorMessage(e))
      } finally {
        setSummarizingAll(false)
        // 完成后刷新「检索索引」覆盖数
        setIndexStats(await api.indexStats().catch(() => null))
      }
    },
    [summarizingAll, onToast]
  )

  const applyToForm = useCallback((s: AppSettings) => {
    setSettings(s)
    setModel(s.aiModel)
    setProviderId(s.aiProvider)
    setCustomBaseUrl(s.aiCustomBaseUrl)
    setSyncWindow(String(s.syncWindow))
    setRefreshSec(String(s.refreshIntervalSec))
    setSummaryPrompt(s.summaryPrompt)
    setAutoSummarizeNew(s.autoSummarizeNew)
    setSmtpHost(s.smtpHost)
    setSmtpPort(String(s.smtpPort))
    setSmtpSecure(s.smtpSecure)
    setSmtpUser(s.smtpUser)
    setSmtpTo(s.smtpTo)
    setSendScope(s.sendScope)
    setTheme(s.theme)
    setDensity(s.density)
    setBrandName(s.brandName)
    setBrandSubtitle(s.brandSubtitle)
    setListPageSize(String(s.listPageSize))
    setRelativeTime(s.relativeTime)
    setOpenMailMarksRead(s.openMailMarksRead)
    setSyncOnStartup(s.syncOnStartup)
    setConfirmBeforeSend(s.confirmBeforeSend)
    setAskTopK(String(s.askTopK))
    setAttachmentDir(s.attachmentDir ?? '')
    setAutoTagEnabled(s.autoTagEnabled)
    setTagVocabulary(s.tagVocabulary)
    setTagVocabList(parseVocabulary(s.tagVocabulary))
  }, [])

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings()
      applyToForm(s)
      onSettingsChanged?.(s)
      setIndexStats(await api.indexStats().catch(() => null))
      setTagExamples(await api.tagExamples().catch(() => []))
      setCategories(await api.listCategories().catch(() => []))
      setTagCounts(await api.tagCounts().catch(() => []))
    } catch (e) {
      onToast(errorMessage(e))
    }
  }, [applyToForm, onSettingsChanged, onToast])

  const rebuildTags = useCallback(async () => {
    if (rebuildingTags) return
    setRebuildingTags(true)
    try {
      const n = await api.rebuildTags()
      setTagCounts(await api.tagCounts().catch(() => []))
      onToast(`已按现有索引卡片重算规则标签（${n} 封，不花 AI 成本）`)
    } catch (e) {
      onToast(errorMessage(e))
    } finally {
      setRebuildingTags(false)
    }
  }, [onToast, rebuildingTags])

  const removeTagExample = useCallback(
    async (id: number) => {
      try {
        await api.setTagExample(id, [])
        setTagExamples(await api.tagExamples().catch(() => []))
        onToast('已移除该示例')
      } catch (e) {
        onToast(errorMessage(e))
      }
    },
    [onToast]
  )

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async () => {
    setSaving(true)
    try {
      const n = Number.parseInt(syncWindow, 10)
      const r = Number.parseInt(refreshSec, 10)
      const size = Number.parseInt(listPageSize, 10)
      const topK = Number.parseInt(askTopK, 10)
      const next = await api.saveSettings({
        aiProvider: providerId,
        aiModel: model,
        aiCustomBaseUrl: customBaseUrl.trim(),
        apiKey: apiKey.trim() === '' ? undefined : apiKey.trim(),
        syncWindow: Number.isFinite(n) && n >= 0 ? n : 0,
        refreshIntervalSec: Number.isFinite(r) && r >= 0 ? r : 0,
        summaryPrompt: summaryPrompt.trim() === '' ? DEFAULT_SUMMARY_PROMPT : summaryPrompt,
        autoSummarizeNew,
        sendScope,
        theme,
        density,
        brandName: brandName.trim() || DEFAULT_BRAND_NAME,
        brandSubtitle: brandSubtitle.trim(),
        listPageSize: Number.isFinite(size) && size >= 5 && size <= 200 ? size : DEFAULT_LIST_PAGE_SIZE,
        relativeTime,
        openMailMarksRead,
        syncOnStartup,
        confirmBeforeSend,
        askTopK: Number.isFinite(topK) && topK >= 3 && topK <= 40 ? topK : DEFAULT_ASK_TOPK,
        attachmentDir: attachmentDir.trim(),
        autoTagEnabled,
        tagVocabulary: tagVocabList.join('、')
      })
      setApiKey('')
      applyToForm(next)
      onSettingsChanged?.(next)
      onToast('设置已保存（外观立即生效）')
    } catch (e) {
      onToast(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }, [
    apiKey,
    applyToForm,
    askTopK,
    providerId,
    customBaseUrl,
    attachmentDir,
    autoTagEnabled,
    tagVocabList,
    autoSummarizeNew,
    brandName,
    brandSubtitle,
    confirmBeforeSend,
    density,
    listPageSize,
    model,
    onSettingsChanged,
    onToast,
    openMailMarksRead,
    refreshSec,
    relativeTime,
    sendScope,
    summaryPrompt,
    syncOnStartup,
    syncWindow,
    theme
  ])

  const saveSmtp = useCallback(async () => {
    const port = Number.parseInt(smtpPort, 10)
    await api.saveSettings({
      smtpHost: smtpHost.trim(),
      smtpPort: Number.isFinite(port) && port > 0 && port < 65536 ? port : 587,
      smtpSecure,
      smtpUser: smtpUser.trim(),
      smtpTo: smtpTo.trim(),
      // 留空 = 保持已保存的密码不变（想清除请点「清除密码」）
      smtpPass: smtpPass === '' ? undefined : smtpPass
    })
    setSmtpPass('')
    await load()
  }, [load, smtpHost, smtpPass, smtpPort, smtpSecure, smtpTo, smtpUser])

  const sendTest = useCallback(async () => {
    if (sendingTest) return
    setSendingTest(true)
    setSendResult(null)
    try {
      await saveSmtp()
      const r = await api.sendTestMail({ to: smtpTo.trim() || smtpUser.trim() })
      setSendResult(r.conclusion)
    } catch (e) {
      setSendResult(errorMessage(e))
    } finally {
      setSendingTest(false)
    }
  }, [saveSmtp, sendingTest, smtpTo, smtpUser])

  const clearSmtpPass = useCallback(async () => {
    try {
      await api.saveSettings({ smtpPass: '' })
      await load()
      onToast('已清除保存的发信密码')
    } catch (e) {
      onToast(errorMessage(e))
    }
  }, [load, onToast])

  const sendSchoolTest = useCallback(async () => {
    if (sendingSchool) return
    setSendingSchool(true)
    setSchoolSendResult(null)
    try {
      const r = await api.sendTestMail({ mode: 'school' })
      setSchoolSendResult(r.conclusion)
    } catch (e) {
      setSchoolSendResult(errorMessage(e))
    } finally {
      setSendingSchool(false)
    }
  }, [sendingSchool])

  const reloginForSend = useCallback(async () => {
    try {
      await api.saveSettings({ sendScope })
      onToast('已退出登录：请用设备码重新登录，授权页会申请发信权限（SMTP.Send）')
      onLogout?.()
    } catch (e) {
      onToast(errorMessage(e))
    }
  }, [onLogout, onToast, sendScope])

  const runSendProbe = useCallback(async () => {
    if (probing) return
    setProbing(true)
    setProbeResult(null)
    try {
      const r = await api.probeSendCapability()
      setProbeResult(r.guidance)
      setDataDir(r.userDataDir ?? null)
    } catch (e) {
      setProbeResult(errorMessage(e))
    } finally {
      setProbing(false)
    }
  }, [probing])

  const addTagVocab = useCallback(() => {
    const t = normalizeTag(tagVocabDraft)
    if (!t) return
    setTagVocabList((prev) => (prev.includes(t) ? prev : [...prev, t]))
    setTagVocabDraft('')
  }, [tagVocabDraft])

  const reloadCategories = useCallback(async () => {
    setCategories(await api.listCategories().catch(() => []))
  }, [])

  const addCategory = useCallback(async () => {
    const name = newCatName.trim()
    if (!name) return
    try {
      await api.createCategory(name, newCatColor)
      setNewCatName('')
      await reloadCategories()
      onToast(`已新建类别「${name}」`)
    } catch (e) {
      onToast(errorMessage(e))
    }
  }, [newCatName, newCatColor, reloadCategories, onToast])

  const pickAttachmentDir = useCallback(async () => {
    try {
      const picked = await api.pickDirectory(attachmentDir || undefined)
      if (!picked) return
      setAttachmentDir(picked)
      onToast(`已选择附件保存目录：${picked}（点「保存设置」后生效）`)
    } catch (e) {
      onToast(errorMessage(e))
    }
  }, [attachmentDir, onToast])

  const clearKey = useCallback(async () => {
    try {
      await api.saveSettings({ apiKey: '' })
      await load()
      onToast('已清除保存的 API Key')
    } catch (e) {
      onToast(errorMessage(e))
    }
  }, [load, onToast])

  return (
    <div className="settings-page" data-testid="settings-page">
      <header className="topbar">
        <div className="title">
          设置 <span className="sub">外观 / 同步 / AI / 发信 —— 点分类标题可折叠</span>
        </div>
      </header>

      {/* 批量总结进度：正在生成哪一封 + 已用/预计还需 + 停止 */}
      <SummaryProgressBar onFinished={() => void api.indexStats().then(setIndexStats).catch(() => undefined)} />

      <div className="settings-shell">
        {/* 左栏：分类导航（像系统设置那样，一次只看一类） */}
        <nav className="settings-nav" data-testid="settings-nav">
          {SECTIONS.map((meta) => (
            <button
              key={meta.id}
              className={`settings-nav-item ${active === meta.id ? 'active' : ''}`}
              onClick={() => selectSection(meta.id)}
              data-testid={`settings-section-${meta.id}`}
            >
              <span className="sec-ico">{meta.icon}</span>
              <span className="sec-title">{meta.title}</span>
              <span className="hint">{meta.hint}</span>
            </button>
          ))}
        </nav>

        {/* 右栏：当前分类的内容 */}
        <div className="settings-pane">
          <div className="settings-pane-head">
            <div className="settings-pane-title">
              {SECTIONS.find((x) => x.id === active)?.icon} {SECTIONS.find((x) => x.id === active)?.title}
            </div>
          </div>
        {/* ── 外观 ── */}
        <div className="settings-section">
          {active === 'appearance' && (
            <div className="settings-section-body settings-card">
              <div className="settings-row">
                <span className="name">主题</span>
                <select
                  className="settings-input"
                  style={{ maxWidth: 260 }}
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as ThemeMode)}
                  data-testid="set-theme"
                >
                  {THEME_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                      {o.hint ? `（${o.hint}）` : ''}
                    </option>
                  ))}
                </select>
                <span className="hint">深色主题为夜间护眼；「跟随系统」会随 Windows 设置自动切换</span>
              </div>
              <div className="settings-row">
                <span className="name">界面密度</span>
                <select
                  className="settings-input"
                  style={{ maxWidth: 260 }}
                  value={density}
                  onChange={(e) => setDensity(e.target.value as UiDensity)}
                  data-testid="set-density"
                >
                  {DENSITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                      {o.hint ? `（${o.hint}）` : ''}
                    </option>
                  ))}
                </select>
                <span className="hint">影响邮件列表行高与正文字号（保存后立即生效）</span>
              </div>
              <div className="settings-row">
                <span className="name">显示名称</span>
                <input
                  className="settings-input"
                  style={{ maxWidth: 240 }}
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  placeholder={DEFAULT_BRAND_NAME}
                  data-testid="set-brand-name"
                />
                <span className="hint">侧边栏与窗口标题显示的名字（可改成你学校的名字，最多 24 字）</span>
              </div>
              <div className="settings-row">
                <span className="name">副标题</span>
                <input
                  className="settings-input"
                  style={{ maxWidth: 240 }}
                  value={brandSubtitle}
                  onChange={(e) => setBrandSubtitle(e.target.value)}
                  placeholder="留空则不显示"
                  data-testid="set-brand-subtitle"
                />
              </div>
              <div className="settings-row">
                <span className="name">列表加载条数</span>
                <input
                  className="settings-input"
                  type="number"
                  min={5}
                  max={200}
                  style={{ maxWidth: 120 }}
                  value={listPageSize}
                  onChange={(e) => setListPageSize(e.target.value)}
                  data-testid="set-list-page-size"
                />
                <span className="hint">一次加载多少封邮件（默认 20；机器较弱时调小更流畅）</span>
              </div>
              <div className="settings-row">
                <span className="name">时间显示</span>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={relativeTime}
                    onChange={(e) => setRelativeTime(e.target.checked)}
                    data-testid="set-relative-time"
                  />
                  <span>列表里显示相对时间（如「3 分钟前」）；取消则显示具体日期时间</span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* ── 同步与通知 ── */}
        <div className="settings-section">
          {active === 'sync' && (
            <div className="settings-section-body settings-card">
              <div className="settings-row">
                <span className="name">同步范围</span>
                <input
                  className="settings-input"
                  type="number"
                  min={0}
                  max={10000}
                  value={syncWindow}
                  onChange={(e) => setSyncWindow(e.target.value)}
                  style={{ maxWidth: 140 }}
                  data-testid="set-syncwindow"
                />
                <span className="hint">0 = 全部历史邮件；&gt;0 = 仅最近 N 封（保存后点「同步」生效）</span>
              </div>
              <div className="settings-row">
                <span className="name">自动刷新</span>
                <input
                  className="settings-input"
                  type="number"
                  min={0}
                  max={86400}
                  value={refreshSec}
                  onChange={(e) => setRefreshSec(e.target.value)}
                  style={{ maxWidth: 140 }}
                  data-testid="set-refresh"
                />
                <span className="hint">
                  每隔多少秒自动增量同步一次；0 = 关闭（默认 300 秒 = 5 分钟）。
                  自动同步在**主进程**按此间隔执行：窗口最小化/隐藏到托盘也照常跑，电脑休眠唤醒后会立即补一次；
                  失败后 60 秒自动重试。
                </span>
              </div>
              <div className="settings-row">
                <span className="name">启动时同步</span>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={syncOnStartup}
                    onChange={(e) => setSyncOnStartup(e.target.checked)}
                    data-testid="set-sync-startup"
                  />
                  <span>应用启动后自动同步一次（默认关闭，避免一打开就占用网络）</span>
                </label>
              </div>
              <div className="settings-row">
                <span className="name">新邮件通知</span>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={autoSummarizeNew}
                    onChange={(e) => setAutoSummarizeNew(e.target.checked)}
                    data-testid="set-auto-summary"
                  />
                  <span>新邮件自动 AI 总结 + Windows 系统通知（未配置 Key 时只发基本信息通知）</span>
                </label>
              </div>
              <div className="settings-row">
                <span className="name">同步策略</span>
                <span className="hint">首次同步全部历史邮件；之后每次只增量拉取新邮件（UID 状态机），不会重复拉旧邮件</span>
              </div>
              <div className="settings-row">
                <span className="name">收不到新邮件 / 少邮件？</span>
                <button className="btn ghost" onClick={() => void repairSync()} disabled={repairing} data-testid="resync-btn">
                  🔧 {repairing ? '修复中…' : '修复同步（重新拉取缺失邮件）'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── AI ── */}
        <div className="settings-section">
          {active === 'ai' && (
            <div className="settings-section-body settings-card">
              <div className="settings-row">
                <span className="name">AI 服务商</span>
                <select
                  className="settings-input"
                  value={providerId}
                  onChange={(e) => {
                    const id = e.target.value
                    setProviderId(id)
                    // 切换到新服务商时把模型带成该服务商默认值（避免用错模型名导致 400）
                    const preset = defaultModelForProvider(id)
                    if (preset) setModel(preset)
                  }}
                  data-testid="set-provider"
                >
                  {AI_PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <span className="hint">{resolveAiProvider(providerId).hint ?? ''}</span>
              </div>
              <div className="settings-row">
                <span className="name">模型</span>
                {providerModels(providerId).length > 0 ? (
                  <select
                    className="settings-input"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    data-testid="set-model"
                  >
                    {providerModels(providerId).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="settings-input"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="手填模型名，例如 qwen2.5:7b"
                    data-testid="set-model"
                  />
                )}
              </div>
              {providerId === 'custom' && (
                <div className="settings-row">
                  <span className="name">Base URL</span>
                  <input
                    className="settings-input"
                    style={{ maxWidth: 360 }}
                    value={customBaseUrl}
                    onChange={(e) => setCustomBaseUrl(e.target.value)}
                    placeholder="https://your-endpoint/v1（OpenAI 兼容）"
                    data-testid="set-custom-base-url"
                  />
                  <span className="hint">本地 Ollama / vLLM / 中转站都可以，只要兼容 /chat/completions</span>
                </div>
              )}
              <div className="settings-row">
                <span className="name">API Key</span>
                <input
                  className="settings-input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    settings?.hasApiKey
                      ? `已保存（${resolveAiProvider(providerId).label}，留空表示不修改）`
                      : `${resolveAiProvider(providerId).label} 的 API Key`
                  }
                  data-testid="set-apikey"
                />
              </div>
              <div className="settings-row">
                <span className="name">Key 状态</span>
                <div className="row-inline">
                  <span className={`hint ${settings?.hasApiKey ? 'ok' : ''}`} data-testid="apikey-status">
                    {settings?.hasApiKey ? '已配置（DPAPI 加密保存，明文不出现在界面与日志）' : '未配置——AI 总结等 AI 功能将不可用'}
                  </span>
                  {settings?.hasApiKey && (
                    <button className="link-btn danger" onClick={() => void clearKey()} data-testid="clear-key">
                      清除 Key
                    </button>
                  )}
                </div>
              </div>
              <div className="settings-row">
                <span className="name">问答引用条数</span>
                <input
                  className="settings-input"
                  type="number"
                  min={3}
                  max={40}
                  style={{ maxWidth: 100 }}
                  value={askTopK}
                  onChange={(e) => setAskTopK(e.target.value)}
                  data-testid="set-ask-topk"
                />
                <span className="hint">
                  每次提问最多参考/引用几封邮件（3-40，默认 5）。调大 = 答案更全、引用更多，但更慢也更费 token；
                  问「全部 / 所有 / 都有哪些」时系统会自动再放大 3 倍（封顶 40）。
                </span>
              </div>
              <div className="settings-row">
                <span className="name">自动标签</span>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={autoTagEnabled}
                    onChange={(e) => setAutoTagEnabled(e.target.checked)}
                    data-testid="set-auto-tag"
                  />
                  <span>
                    自动给邮件打标签（A 规则：类型/课程号/平台/截止紧急度，零成本；B AI 主题标签：在生成摘要时顺带产出）
                  </span>
                </label>
              </div>
              <div className="settings-row">
                <span className="name" />
                <div className="row-inline">
                <span className="name">标签词表</span>
                <div className={`vocab-editor ${showAllVocab ? '' : 'collapsed'}`} data-testid="tag-vocab-editor">
                  {tagVocabList.map((t) => (
                    <span key={t} className="vocab-chip">
                      {t}
                      <button
                        className="vocab-del"
                        title={`删除标签「${t}」`}
                        onClick={() => setTagVocabList((prev) => prev.filter((x) => x !== t))}
                        data-testid="tag-vocab-remove"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  <input
                    className="settings-input vocab-input"
                    value={tagVocabDraft}
                    placeholder="输入标签后按 Enter 或点 ＋"
                    onChange={(e) => setTagVocabDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addTagVocab()
                      }
                    }}
                    data-testid="tag-vocab-input"
                  />
                  <button className="btn ghost" onClick={() => addTagVocab()} data-testid="tag-vocab-add">
                    ＋ 添加
                  </button>
                  <button className="link-btn" onClick={() => setShowAllVocab((v) => !v)} data-testid="toggle-vocab">
                    {showAllVocab ? '收起' : `展开全部（${tagVocabList.length}）`}
                  </button>
                  <button
                    className="link-btn"
                    onClick={() => setTagVocabList([...DEFAULT_TAG_VOCABULARY])}
                    data-testid="reset-tag-vocab"
                  >
                    恢复默认
                  </button>
                </div>
              </div>
              </div>
              <div className="settings-row">
                <span className="name" />
                <div className="row-inline">
                <span className="name">已打标签</span>
                <span className="hint" data-testid="tag-counts">
                  {tagCounts.length > 0
                    ? `${tagCounts.length} 个标签（${tagCounts
                        .slice(0, 6)
                        .map((t) => `${t.tag} ${t.count}`)
                        .join('、')}…）`
                    : '还没有标签——批量总结后会自动生成'}
                </span>
                <button className="btn ghost" onClick={() => void rebuildTags()} disabled={rebuildingTags} data-testid="rebuild-tags">
                  🔁 {rebuildingTags ? '重算中…' : '按索引卡片重算规则标签'}
                </button>
              </div>
              </div>
              {/* V2.2：彩色类别管理 —— 每个类别一行（与其它设置行同样的「标签列 + 内容列」网格），
                  单行内完成「改名 / 改色 / 删除」，不再换行、不再占一大块 */}
              <div className="settings-row">
                <span className="name">彩色类别</span>
                <div className="row-inline">
                  <span className="hint">一封邮件一个类别；标记后列表里该邮件会用对应颜色标出。</span>
                </div>
              </div>
              {categories.map((c) => (
                <div key={c.id} className="settings-row" data-testid="category-manage-row">
                  <span className="name">
                    <span className="label-dot" style={{ background: c.color }} />
                    <span className="cat-label-text">{c.name}</span>
                  </span>
                  <div className="row-inline">
                    <input
                      className="settings-input cat-name-input"
                      defaultValue={c.name}
                      onBlur={(e) => {
                        const name = e.target.value.trim()
                        if (name && name !== c.name) void api.updateCategory(c.id, { name }).then(reloadCategories)
                      }}
                      data-testid="category-manage-name"
                    />
                    <input
                      type="color"
                      className="category-color"
                      defaultValue={c.color}
                      onChange={(e) => void api.updateCategory(c.id, { color: e.target.value }).then(reloadCategories)}
                      title="改颜色"
                      data-testid="category-manage-color"
                    />
                    <button
                      className="link-btn danger"
                      onClick={() => void api.deleteCategory(c.id).then(reloadCategories)}
                      data-testid="category-manage-delete"
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
              <div className="settings-row">
                <span className="name">新建类别</span>
                <div className="row-inline">
                  <input
                    className="settings-input cat-name-input"
                    placeholder="类别名称"
                    value={newCatName}
                    onChange={(e) => setNewCatName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addCategory()
                    }}
                    data-testid="category-new-name"
                  />
                  <div className="category-colors">
                    {CATEGORY_COLORS.map((color) => (
                      <button
                        key={color}
                        className={`category-swatch ${newCatColor === color ? 'on' : ''}`}
                        style={{ background: color }}
                        onClick={() => setNewCatColor(color)}
                        title={color}
                      />
                    ))}
                  </div>
                  <button className="btn ghost" onClick={() => void addCategory()} data-testid="category-create">
                    ＋ 新建类别
                  </button>
                </div>
              </div>
              <div className="settings-row settings-row-top">
                <span className="name">AI 标签示例</span>
                <span className="hint">
                  在邮件详情页点「🏷 设为 AI 标签示例」挑几封作为参考；示例只保存主题与标签，模型会照这个口径打标签。
                </span>
              </div>
              {tagExamples.length > 0 ? (
                <div className="tag-example-list" data-testid="tag-example-list">
                  {tagExamples.map((e) => (
                    <div key={e.id} className="tag-example-item">
                      <span className="subj">{e.subject.slice(0, 40)}</span>
                      <span className="tags">{e.tags.join('、')}</span>
                      <button className="link-btn danger" onClick={() => void removeTagExample(e.id)} data-testid="tag-example-remove">
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="settings-row">
                  <span className="name" />
                  <span className="hint">还没有示例邮件。</span>
                </div>
              )}
              <div className="settings-row">
                <span className="name">检索索引</span>
                <span className="hint" data-testid="index-stats">
                  {indexStats
                    ? `已建 ${indexStats.total - indexStats.missing}/${indexStats.total} 封（AI 助手问答用；缺的会在批量总结时自动补齐）`
                    : '统计中…'}
                </span>
              </div>
              <div className="settings-row">
                <span className="name">批量 AI 总结</span>
                <button
                  className="btn ghost"
                  onClick={() => void summarizeAll(false)}
                  disabled={summarizingAll}
                  data-testid="settings-summarize-pending"
                >
                  🧠 {summarizingAll ? '总结中…' : '总结所有未生成摘要的邮件'}
                </button>
              </div>
              <div className="settings-row">
                <span className="name">摘要质量修复</span>
                <button
                  className="btn ghost"
                  onClick={() => void summarizeAll(true)}
                  disabled={summarizingAll}
                  data-testid="settings-regenerate-summaries"
                >
                  🔁 {summarizingAll ? '生成中…' : '重新生成全部摘要（覆盖旧的）'}
                </button>
              </div>
              <div className="settings-row">
                <span className="name" />
                <div className="row-inline">
                <span className="name">总结提示词</span>
                <span className="hint">自定义 AI 总结的提问方式（默认已针对「学生 + 过滤广告」调优）</span>
                <button
                  className="link-btn"
                  onClick={() => {
                    setSummaryPrompt(DEFAULT_SUMMARY_PROMPT)
                    onToast('已恢复默认提示词（保存后生效）')
                  }}
                  data-testid="reset-prompt"
                  style={{ width: "auto", justifySelf: "start" }}
                >
                  恢复默认
                </button>
              </div>
              </div>
              <textarea
                className="settings-textarea"
                rows={8}
                value={summaryPrompt}
                onChange={(e) => setSummaryPrompt(e.target.value)}
                data-testid="set-prompt"
              />
            </div>
          )}
        </div>

        {/* ── 发信 ── */}
        <div className="settings-section">
          {active === 'send' && (
            <div className="settings-section-body settings-card">
              <div className="settings-row">
                <span className="name">发信权限</span>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={sendScope}
                    onChange={(e) => setSendScope(e.target.checked)}
                    data-testid="set-send-scope"
                  />
                  <span>登录时申请发信权限（SMTP.Send）——改动后需重新登录一次；取消勾选并重新登录即只收不发（收信始终只读）</span>
                </label>
                <button className="btn ghost" onClick={() => void reloginForSend()} data-testid="relogin-send-scope">
                  🔑 退出并重新登录
                </button>
              </div>
              <div className="settings-row">
                <span className="name">发送前确认</span>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={confirmBeforeSend}
                    onChange={(e) => setConfirmBeforeSend(e.target.checked)}
                    data-testid="set-confirm-send"
                  />
                  <span>点「发送」时先弹确认框（防止手滑发出）</span>
                </label>
              </div>
              <div className="settings-row">
                <span className="name">学校账号发信测试</span>
                <button className="btn ghost" onClick={() => void sendSchoolTest()} disabled={sendingSchool} data-testid="school-send-test-btn">
                  ✉️ {sendingSchool ? '发送中…' : '用学校账号发测试邮件给自己'}
                </button>
              </div>
              {schoolSendResult && (
                <div className="settings-row">
                  <span className="name" />
                  <span className="hint" data-testid="school-send-result" style={{ color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>
                    {schoolSendResult}
                  </span>
                </div>
              )}
              <div className="settings-row">
                <span className="name">发送能力自检</span>
                <button className="btn ghost" onClick={() => void runSendProbe()} disabled={probing} data-testid="smtp-probe-btn">
                  📮 {probing ? '检测中…' : '检测发送权限（不会发送邮件）'}
                </button>
              </div>
              {probeResult && (
                <div className="settings-row">
                  <span className="name" />
                  <span className="hint" data-testid="smtp-probe-result" style={{ color: 'var(--text-2)' }}>
                    {probeResult}
                  </span>
                </div>
              )}
              <div className="settings-row">
                <span className="name" />
                <span className="hint">
                  发送需要额外授权：① 微软 365 的 SMTP AUTH（scope SMTP.Send，且学校需允许）或 ② Graph Mail.Send（需管理员同意）。
                  不勾选发信权限时，学校账号的「发送」保持关闭（收信不受影响，仍是只读同步）。
                </span>
              </div>

              <div className="lbl" style={{ marginTop: 10 }}>
                个人邮箱发信（不影响学校账号的只读收信）
              </div>
              <div className="settings-row">
                <span className="name" />
                <span className="hint">
                  想先验证「到底能不能发信」？填一个你自己的邮箱（Gmail / Outlook 个人邮箱等）的应用密码，发一封测试邮件给自己。
                  密码只经 DPAPI 加密保存在本机，不会写日志、不会回显、不会用于其它用途。
                </span>
              </div>
              <div className="settings-row">
                <span className="name">SMTP 服务器</span>
                <input
                  className="input"
                  style={{ maxWidth: 220 }}
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  placeholder="smtp.gmail.com"
                  data-testid="set-smtp-host"
                />
                <input
                  className="input"
                  style={{ maxWidth: 90 }}
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(e.target.value)}
                  placeholder="587"
                  data-testid="set-smtp-port"
                />
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={smtpSecure}
                    onChange={(e) => setSmtpSecure(e.target.checked)}
                    data-testid="set-smtp-secure"
                  />
                  <span>直连 SSL/TLS（465）</span>
                </label>
              </div>
              <div className="settings-row">
                <span className="name">发信邮箱</span>
                <input
                  className="input"
                  style={{ maxWidth: 260 }}
                  value={smtpUser}
                  onChange={(e) => setSmtpUser(e.target.value)}
                  placeholder="you@gmail.com"
                  data-testid="set-smtp-user"
                />
              </div>
              <div className="settings-row">
                <span className="name">密码 / 应用密码</span>
                <input
                  className="input"
                  type="password"
                  style={{ maxWidth: 260 }}
                  value={smtpPass}
                  onChange={(e) => setSmtpPass(e.target.value)}
                  placeholder={settings?.hasSmtpPass ? '已保存（留空则不改）' : '应用密码'}
                  data-testid="set-smtp-pass"
                />
                <button className="btn ghost" onClick={() => void clearSmtpPass()} data-testid="clear-smtp-pass">
                  清除密码
                </button>
              </div>
              <div className="settings-row">
                <span className="name">测试收件人</span>
                <input
                  className="input"
                  style={{ maxWidth: 260 }}
                  value={smtpTo}
                  onChange={(e) => setSmtpTo(e.target.value)}
                  placeholder="留空 = 发给自己"
                  data-testid="set-smtp-to"
                />
                <button className="btn ghost" onClick={() => void sendTest()} disabled={sendingTest} data-testid="smtp-send-test-btn">
                  ✉️ {sendingTest ? '发送中…' : '发送测试邮件'}
                </button>
              </div>
              {sendResult && (
                <div className="settings-row">
                  <span className="name" />
                  <span className="hint" data-testid="smtp-send-result" style={{ color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>
                    {sendResult}
                  </span>
                </div>
              )}
              <div className="settings-row">
                <span className="name" />
                <span className="hint" style={{ color: 'var(--text-3)' }}>
                  常见坑：Gmail 需要先开两步验证再生成「应用专用密码」；Outlook 个人邮箱需在账户安全里允许 SMTP AUTH；
                  学校/公司邮箱通常直接禁用 SMTP AUTH，那就只能走 Graph/管理员授权。
                </span>
              </div>
            </div>
          )}
        </div>

        {/* ── 账户 ── */}
        <div className="settings-section">
          {active === 'account' && (
            <div className="settings-section-body settings-card">
              <div className="settings-row">
                <span className="name">当前账户</span>
                <span className="hint">{auth.email ?? '—'}</span>
                {onLogout && (
                  <button className="btn ghost" onClick={onLogout} data-testid="settings-logout">
                    ↪ 退出登录
                  </button>
                )}
              </div>
              <div className="settings-row">
                <span className="name" />
                <span className="hint">
                  登录走微软设备码（OAuth），默认只申请 IMAP 只读（勾了发信权限才会多申请 SMTP.Send）。令牌经 Windows DPAPI 加密保存在本机。
                </span>
              </div>
            </div>
          )}
        </div>

        {/* ── 关于与数据 ── */}
        <div className="settings-section">
          {active === 'about' && (
            <div className="settings-section-body settings-card">
              <div className="settings-row">
                <span className="name">打开即已读</span>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={openMailMarksRead}
                    onChange={(e) => setOpenMailMarksRead(e.target.checked)}
                    data-testid="set-open-read"
                  />
                  <span>点开邮件时在本地标记为已读（只改本地库，不动服务器）</span>
                </label>
              </div>
              <div className="settings-row">
                <span className="name" />
                <div className="row-inline">
                <span className="name">附件保存位置</span>
                <input
                  className="settings-input"
                  style={{ maxWidth: 320 }}
                  value={attachmentDir}
                  onChange={(e) => setAttachmentDir(e.target.value)}
                  placeholder="留空 = 每次保存时询问（推荐）"
                  data-testid="set-attachment-dir"
                />
                <button className="btn ghost" onClick={() => void pickAttachmentDir()} data-testid="pick-attachment-dir">
                  📂 选择文件夹
                </button>
                {attachmentDir ? (
                  <>
                    <button
                      className="btn ghost"
                      onClick={() => void api.openPath(attachmentDir).catch((e) => onToast(errorMessage(e)))}
                      data-testid="open-attachment-dir"
                    >
                      打开
                    </button>
                    <button className="btn ghost" onClick={() => setAttachmentDir('')} data-testid="clear-attachment-dir">
                      改回每次询问
                    </button>
                  </>
                ) : null}
                <span className="hint">下载附件时的落盘位置；留空则每次弹系统保存对话框（最不容易误存）</span>
              </div>
              </div>
              <div className="settings-row">
                <span className="name">数据位置</span>
                <span className="hint" data-testid="data-dir">
                  {dataDir ?? '点上方「检测发送权限」会顺带显示本地数据目录'}
                </span>
              </div>
              <div className="settings-row">
                <span className="name">隐私</span>
                <span className="hint">
                  邮件、摘要、索引与对话全部存在本机 SQLite；只有调用 AI 时才会把「本次相关的几封邮件内容」发给 DeepSeek。
                  不联网同步、不上传通讯录、不共享给第三方。
                </span>
              </div>
              <div className="settings-row">
                <span className="name">收信侧</span>
                <span className="hint">
                  完全只读：不删除/不移动服务器邮件，也不会把服务器上的邮件标记为已读（「已读」只是本地状态）。
                </span>
              </div>
              <div className="settings-row">
                <span className="name">模型校验</span>
                <span className="hint">模型名已内置校验：弃用的 deepseek-chat / deepseek-reasoner 会被拒绝。</span>
              </div>
              <div className="settings-row">
                <span className="name" />
                <div className="row-inline">
                <span className="name">恢复默认外观</span>
                <button
                  className="btn ghost"
                  onClick={() => {
                    setTheme('system')
                    setDensity('standard')
                    setBrandName(DEFAULT_BRAND_NAME)
                    setBrandSubtitle(DEFAULT_BRAND_SUBTITLE)
                    onToast('已恢复默认外观（点「保存设置」生效）')
                  }}
                  data-testid="reset-appearance"
                >
                  ↩ 主题/密度/名称恢复默认
                </button>
              </div>
              </div>
            </div>
          )}
        </div>

          <div className="settings-foot">
            <span className="hint">改完点「保存设置」生效；同步/发信类设置保存后再点对应按钮。</span>
            <button className="btn primary" onClick={() => void save()} disabled={saving} data-testid="settings-save-bottom">
              {saving ? '保存中…' : '保存设置'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
})

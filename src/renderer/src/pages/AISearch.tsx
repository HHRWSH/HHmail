/**
 * AI 助手页（M4：聊天式界面）。
 *
 * 用户要求「像市面上的 AI 客户端」：多轮对话（带上下文）+ 新建对话 + 历史列表。
 * 布局：
 *   左栏：＋ 新建对话、会话列表（标题/时间/条数，可删除）
 *   右栏：消息流（用户右侧气泡、助手左侧气泡：Markdown 预览 + 可点击引用）+ 底部输入框
 * 行为：
 *   - 每条提问由服务端带上该会话最近 8 条消息作为上下文（消息持久化在本地 SQLite）；
 *   - 能力/寒暄类问题由服务端路由直接回答、不检索邮件（真机回归：问「你能调用知识库吗」曾被当成搜邮件 → 答「未找到」）；
 *   - 知识库「✨ 问 AI」经 presetQuestion 带问题进来：等会话初始化完成后自动提问一次。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, ChatSession } from '@shared/types'
import { formatRelativeDate } from '@shared/format'
import { renderMarkdown } from '@shared/markdown'
import { linkifyCitations, mailIdFromHref } from '@shared/citations'
import { api } from '../bridge'
import { useSettings } from '../settings-context'
import { errorMessage } from '../lib/errors'
import { SummaryProgressBar } from '../components/SummaryProgressBar'
import type { PageProps } from '../registry'

const SUGGESTIONS = ['这周有什么截止？', '上周导师发了什么邮件？', '有哪些奖学金申请要到期了？', '你能做什么？']

export const AISearchPage = memo(function AISearchPage({ onToast, onOpenMail, isActive, presetQuestion }: PageProps) {
  const settings = useSettings()
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [ready, setReady] = useState(false)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  // 每条助手消息可单独切「Markdown 预览 / 源码」
  const [showSource, setShowSource] = useState<Record<number, boolean>>({})
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const loadSessions = useCallback(async (): Promise<ChatSession[]> => {
    try {
      const list = await api.chatSessions()
      setSessions(list)
      return list
    } catch (e) {
      onToast(errorMessage(e))
      return []
    }
  }, [onToast])

  const openSession = useCallback(
    async (id: number) => {
      setSessionId(id)
      try {
        setMessages(await api.chatMessages(id))
      } catch (e) {
        onToast(errorMessage(e))
      }
    },
    [onToast]
  )

  const newSession = useCallback(async (): Promise<number | null> => {
    try {
      const id = await api.newChatSession()
      await loadSessions()
      setSessionId(id)
      setMessages([])
      return id
    } catch (e) {
      onToast(errorMessage(e))
      return null
    }
  }, [loadSessions, onToast])

  const removeSession = useCallback(
    async (id: number) => {
      try {
        await api.deleteChatSession(id)
        const list = await loadSessions()
        if (sessionId !== id) return
        const next = list[0]
        if (next) await openSession(next.id)
        else {
          setSessionId(null)
          setMessages([])
        }
      } catch (e) {
        onToast(errorMessage(e))
      }
    },
    [loadSessions, onToast, openSession, sessionId]
  )

  /** 进入页面：加载会话列表；一个都没有就新建（保证随时能打字） */
  useEffect(() => {
    if (isActive === false) return
    let cancelled = false
    void (async () => {
      const list = await loadSessions()
      if (cancelled) return
      if (list.length > 0) await openSession(list[0].id)
      else await newSession()
      if (!cancelled) setReady(true)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  const ask = useCallback(
    async (text: string) => {
      const q = text.trim()
      if (!q || asking) return
      let sid = sessionId
      if (sid === null) sid = await newSession()
      if (sid === null) return
      setAsking(true)
      setQuestion('')
      // 先本地回显用户消息（id 为负数的临时条目，服务端返回后以真实消息替换）
      setMessages((prev) => [
        ...prev,
        { id: -Date.now(), sessionId: sid as number, role: 'user', content: q, citations: [], createdAt: Date.now() }
      ])
      try {
        const reply = await api.chatAsk(sid, q, settings.askTopK)
        // 以服务端为准刷新整个消息流：用户消息在服务端也存了一份（本地回显是临时负数 id），
        // 只 append 助手消息会把用户自己那条从界面上"吃掉"（真机/ E2E 都暴露过）
        try {
          setMessages(await api.chatMessages(sid))
        } catch {
          setMessages((prev) => [...prev.filter((m) => m.id > 0), reply])
        }
        void loadSessions()
      } catch (e) {
        onToast(errorMessage(e))
        setMessages((prev) => prev.filter((m) => m.id > 0))
        setQuestion(q)
      } finally {
        setAsking(false)
        window.setTimeout(() => inputRef.current?.focus(), 0)
      }
    },
    [asking, loadSessions, newSession, onToast, sessionId, settings.askTopK]
  )

  /** 知识库「✨ 问 AI」：会话就绪后自动提问一次（同一问题只消费一次） */
  const presetRef = useRef<string | null>(null)
  useEffect(() => {
    const q = (presetQuestion ?? '').trim()
    if (!ready || !q || presetRef.current === q) return
    presetRef.current = q
    void ask(q)
  }, [ask, presetQuestion, ready])

  /** 新消息 / 思考中都滚到底部 */
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, asking])

  const currentTitle = useMemo(
    () => sessions.find((s) => s.id === sessionId)?.title ?? '新对话',
    [sessions, sessionId]
  )

  return (
    <div className="chat-page" data-testid="ai-search-page">
      {/* 左栏：会话列表 */}
      <aside className="chat-side">
        <button className="btn primary chat-new" onClick={() => void newSession()} data-testid="chat-new">
          ＋ 新建对话
        </button>
        <div className="chat-sessions" data-testid="chat-sessions">
          {sessions.length === 0 && <div className="chat-side-hint">还没有对话</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`chat-session ${s.id === sessionId ? 'active' : ''}`}
              onClick={() => void openSession(s.id)}
              data-testid="chat-session"
            >
              <div className="chat-session-main">
                <div className="chat-session-title">{s.title}</div>
                <div className="chat-session-meta">
                  {formatRelativeDate(s.updatedAt)} · {s.messageCount} 条
                </div>
              </div>
              <button
                className="link-btn chat-session-del"
                title="删除这个对话"
                onClick={(e) => {
                  e.stopPropagation()
                  void removeSession(s.id)
                }}
                data-testid="chat-session-delete"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* 右栏：消息流 + 输入 */}
      <section className="chat-main">
        <header className="chat-head">
          <div className="chat-title" data-testid="chat-title">
            ✨ {currentTitle}
          </div>
        </header>

        {/* 批量总结进度（在设置页触发时，这里也能看到进度） */}
        <SummaryProgressBar />

        <div className="chat-list" ref={listRef} data-testid="chat-list">
          {messages.length === 0 && !asking && (
            <div className="chat-empty">
              <div className="chat-empty-icon">✨</div>
              <div className="chat-empty-title">问收件箱里的任何事</div>
              <div className="chat-empty-sub">
                我只依据本地已同步的邮件回答（索引卡片 → 摘要 → 原文），找不到就说找不到。
              </div>
              <div className="chat-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="chip" onClick={() => void ask(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.role}`} data-testid={`chat-msg-${m.role}`}>
              <div className="chat-avatar">{m.role === 'user' ? '我' : '✨'}</div>
              <div className="chat-msg-body">
                {/* V2.2：引用放在回答**上面**（用户反馈底下一堆索引反而找不到），
                    并且只显示回答里真正提到的邮件；回答正文里的邮件名也可点击跳转 */}
                {m.role === 'assistant' && m.citations.length > 0 && (
                  <div className="ai-search-cites" data-testid="chat-citations">
                    <div className="ai-search-cites-head">引用邮件（点击直接打开）</div>
                    <div className="ai-search-cite-row">
                      {m.citations.map((c) => (
                        <button
                          key={c.id}
                          className="ai-search-cite"
                          onClick={() => onOpenMail?.(c.id)}
                          data-testid="ai-ask-cite"
                        >
                          <span className="n">📧</span>
                          <span className="c">{c.subject}</span>
                          <span className="d">{c.fromName || ''}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div
                  className="chat-bubble"
                  onClick={(e) => {
                    // 回答里的邮件名是 #mail-<id> 锚点：点一下跳回收件箱那封邮件
                    const target = (e.target as HTMLElement).closest('a')
                    const id = mailIdFromHref(target?.getAttribute('href'))
                    if (id !== null) {
                      e.preventDefault()
                      onOpenMail?.(id)
                    }
                  }}
                >
                  {m.role === 'user' ? (
                    <div className="chat-user-text">{m.content}</div>
                  ) : (
                    <>
                      <div className="chat-bubble-tools">
                        <button
                          className="link-btn"
                          onClick={() => setShowSource((v) => ({ ...v, [m.id]: !v[m.id] }))}
                          data-testid="answer-view-toggle"
                        >
                          {showSource[m.id] ? '👁 预览' : '⌨ 源码'}
                        </button>
                      </div>
                      {showSource[m.id] ? (
                        <pre className="plain chat-pre">{m.content}</pre>
                      ) : (
                        <div
                          className="md-body"
                          data-testid="ai-ask-answer-md"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(linkifyCitations(m.content, m.citations)) }}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}

          {asking && (
            <div className="chat-msg assistant" data-testid="chat-thinking">
              <div className="chat-avatar">✨</div>
              <div className="chat-msg-body">
                <div className="chat-bubble chat-bubble-loading">正在检索邮件并整理答案…</div>
              </div>
            </div>
          )}
        </div>

        <div className="chat-input-row">
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void ask(question)
              }
            }}
            rows={2}
            data-testid="ai-ask-input"
          />
          <button className="btn primary" onClick={() => void ask(question)} disabled={asking} data-testid="ai-ask-send">
            {asking ? '思考中…' : '提问'}
          </button>
        </div>
      </section>
    </div>
  )
})

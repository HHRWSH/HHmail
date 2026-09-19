/**
 * 登录页：设备码 + 验证链接 + 轮询状态 + 中文错误提示（规范 §7 登录页）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthStatus, DeviceCodeEvent, DeviceCodeInfo } from '@shared/types'
import { api } from '../bridge'
import { errorMessage } from '../lib/errors'

interface Props {
  onLoggedIn: (status: AuthStatus) => void
  onToast: (message: string) => void
}

type Phase = 'idle' | 'started' | 'polling' | 'error' | 'expired'

export function LoginPage({ onLoggedIn, onToast }: Props) {
  const [info, setInfo] = useState<DeviceCodeInfo | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [attempts, setAttempts] = useState(0)
  const [error, setError] = useState('')
  const busy = useRef(false)

  const start = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    setError('')
    setPhase('started')
    try {
      const deviceInfo = await api.startDeviceCode()
      setInfo(deviceInfo)
    } catch (e) {
      setPhase('error')
      setError(errorMessage(e))
    } finally {
      busy.current = false
    }
  }, [])

  useEffect(() => {
    const unsubscribe = api.onDeviceCodeEvent((event: DeviceCodeEvent) => {
      switch (event.type) {
        case 'started':
          setPhase('started')
          break
        case 'polling':
          setPhase('polling')
          setAttempts(event.attempts)
          break
        case 'success':
          setPhase('idle')
          onLoggedIn({ loggedIn: true, email: event.email })
          break
        case 'error':
          setPhase('error')
          setError(event.message || errorMessage({ code: event.code }))
          break
        case 'expired':
          setPhase('expired')
          setError('设备码已过期，请点击「重新生成设备码」。')
          break
        case 'cancelled':
          setPhase('idle')
          break
      }
    })
    return unsubscribe
  }, [onLoggedIn])

  const openVerification = useCallback(() => {
    if (!info) return
    const url = info.verificationUri
    const confirmed = window.confirm(`将打开微软登录页（${url}）\n\n请在浏览器中输入设备码完成授权。是否继续？`)
    if (!confirmed) return
    api.openExternal(url).catch((e) => onToast(errorMessage(e)))
  }, [info, onToast])

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-appicon">✉</div>
        <h1>HHmail</h1>
        <p className="desc">
          用微软账号登录你的学校邮箱（Microsoft 365 / Outlook）：收信只读、支持发信，AI 摘要与问答。
          <br />
          支持任意学校或组织的邮箱账号，不绑定特定大学。
        </p>

        {info && (
          <div className="device-code-wrap">
            <div className="lbl">在浏览器打开微软登录页并输入此码</div>
            <div className="device-code">{info.userCode}</div>
          </div>
        )}

        <div className="login-actions">
          {!info ? (
            <button className="btn-primary" onClick={() => void start()}>
              开始登录（设备码）
            </button>
          ) : (
            <>
              <button className="btn-primary" onClick={openVerification}>
                打开验证页面（{info.verificationUri.replace(/^https:\/\//, '')}）
              </button>
              <button className="btn-ghost" onClick={() => void start()}>
                重新生成设备码
              </button>
            </>
          )}
        </div>

        {phase === 'polling' && <div className="login-status">正在等待授权…（第 {attempts} 次查询）</div>}
        {phase === 'error' && <div className="login-status error">{error}</div>}
        {phase === 'expired' && <div className="login-status error">{error}</div>}

        <div className="foot">
          登录即表示同意本应用以只读方式（IMAP XOAUTH2，不改动服务端邮件）读取你的收件箱；勾选发信权限后才会申请 SMTP.Send。
          <br />
          凭证经 Windows DPAPI 加密保存在本机。
        </div>
      </div>
    </div>
  )
}

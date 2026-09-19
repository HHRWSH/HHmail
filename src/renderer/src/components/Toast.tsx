import { useEffect } from 'react'

export interface ToastState {
  id: number
  message: string
}

export function Toast({ toast, onDone }: { toast: ToastState; onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, 2200)
    return () => window.clearTimeout(t)
  }, [toast.id, onDone])

  return <div className="toast show">{toast.message}</div>
}

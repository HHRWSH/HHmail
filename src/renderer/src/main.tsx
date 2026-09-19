import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// 首屏先套用上次的主题（避免加载设置前闪一下白/黑）；设置加载后会以真实设置为准。
try {
  const cached = window.localStorage.getItem('mail-ai-theme')
  if (cached === 'dark' || cached === 'light') document.documentElement.dataset.theme = cached
} catch {
  /* ignore */
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

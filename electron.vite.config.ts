import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// 生产环境严格 CSP（邮件客户端安全基线，见规范 §2 第 10 条）
// img-src 放行 https:：远程图片默认仍不加载（sanitize 移除），用户点「加载图片」后才渲染
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'"
].join('; ')

// 开发环境 CSP：放行 Vite dev server / HMR，其余保持收紧
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: http://localhost:* http://127.0.0.1:*",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "frame-src 'none'"
].join('; ')

function cspPlugin() {
  return {
    name: 'inject-csp',
    transformIndexHtml(html: string, ctx: { server?: unknown }) {
      const csp = ctx && ctx.server ? DEV_CSP : PROD_CSP
      return html.replace('__CSP_PLACEHOLDER__', csp)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react(), cspPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    // 打包后以 file:// 加载，资源必须用相对路径
    base: './'
  }
})

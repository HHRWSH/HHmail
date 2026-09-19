/**
 * renderer 侧的 api 桥：优先 window.api（Electron preload 白名单），
 * 浏览器预览 / E2E 环境（无 preload）回退到内置 mock 桥（仅自测用）。
 */
import type { WindowApi } from '@shared/api'
import { createMockBridge } from './mockBridge'

function resolveApi(): WindowApi {
  if (window.api) return window.api
  // 浏览器环境（demo 预览 / E2E）：mock 桥，不发起任何真实网络请求
  console.info('[bridge] window.api 不存在，使用内置 mock 桥（仅自测/预览）')
  return createMockBridge()
}

export const api: WindowApi = resolveApi()

/**
 * 视觉风格预设（V2.6）：用户可以在设置里切换整套皮肤（亮/暗各自一套）。
 *
 * 布局保持不变（侧边栏 + 邮件列表 + 详情三栏），只切「外观令牌」：
 * 背景、面板/卡片颜色、描边、圆角、阴影、字体（衬线/无衬线）、强调色。
 *
 * 实现方式：`<html data-style="...">` + CSS 变量覆盖（见 styles.css 末尾的 style presets 段），
 * 因此切换是纯 CSS 的、即时生效、不需要重渲染。
 */

export type UiStyle = 'apple' | 'linear' | 'notion' | 'paper' | 'glass'

export interface UiStyleMeta {
  id: UiStyle
  label: string
  /** 一句话说明（设置页展示） */
  desc: string
  /** 预览用的三个颜色（设置页小色块） */
  swatch: [string, string, string]
}

export const UI_STYLES: readonly UiStyleMeta[] = [
  {
    id: 'apple',
    label: 'Apple 原生',
    desc: '大面积留白 + 细分割线 + 系统蓝，干净耐看（默认）',
    swatch: ['#f5f5f7', '#ffffff', '#0071e3']
  },
  {
    id: 'linear',
    label: 'Linear 工具',
    desc: '发丝边框 + 小圆角 + 紫蓝强调，密度高、专业感强',
    swatch: ['#0b0c0f', '#16171c', '#7c8cf8']
  },
  {
    id: 'notion',
    label: 'Notion 暖白',
    desc: '米白底 + 衬线大标题 + 柔和灰绿，温暖、像第二大脑',
    swatch: ['#f7f6f3', '#ffffff', '#37352f']
  },
  {
    id: 'paper',
    label: '纸张编辑',
    desc: '暖纸色 + 衬线正文 + 细线，阅读长邮件最舒服',
    swatch: ['#faf6ef', '#fffdf8', '#b4532a']
  },
  {
    id: 'glass',
    label: '玻璃拟态',
    desc: '渐变光晕 + 毛玻璃面板 + 大圆角，视觉最"炫"',
    swatch: ['#eef1ff', 'rgba(255,255,255,0.62)', '#7c3aed']
  }
] as const

export const DEFAULT_UI_STYLE: UiStyle = 'apple'

export function isUiStyle(value: unknown): value is UiStyle {
  return typeof value === 'string' && UI_STYLES.some((s) => s.id === value)
}

/** 容错：非法值回退默认（老配置/手改配置文件都不会让界面空掉） */
export function normalizeUiStyle(value: unknown): UiStyle {
  return isUiStyle(value) ? value : DEFAULT_UI_STYLE
}

/** 设置页展示用：按 id 取元信息 */
export function uiStyleMeta(id: string | null | undefined): UiStyleMeta {
  return UI_STYLES.find((s) => s.id === id) ?? UI_STYLES[0]
}

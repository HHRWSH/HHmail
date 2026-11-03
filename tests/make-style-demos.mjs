// 生成 5 套风格的「收件箱」demo 页面（同一内容/同一布局，只有视觉风格不同），供用户挑风格
// 输出：program/docs/design/styles/style-N-*.html
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '..', 'docs', 'design', 'styles')
fs.mkdirSync(OUT, { recursive: true })

const mails = [
  { from: 'Prof. 林教授', subject: '关于毕业论文进度的沟通', snippet: '附件里是我整理的时间表，下周三前把初稿发我看看……', time: '刚刚', unread: true, avatar: '林', color: '#3b82f6', att: true },
  { from: '教务处', subject: '【重要】关于选课与学费缴费的通知', snippet: '本学期第二阶段选课将于 11 月 7 日 18:00 截止，请及时确认……', time: '1 小时前', unread: true, avatar: '教', color: '#0ea5e9' },
  { from: '图书馆', subject: 'CSE 系周会纪要 & 下周活动安排', snippet: '本周五 15:30 在 SHB 123 举行系周会，会后有茶歇……', time: '2 小时前', unread: true, avatar: '图', color: '#8b5cf6' },
  { from: 'IT 服务台', subject: '您借阅的资源即将到期，请及时归还', snippet: '您借阅的《Computer Networks》将于 11 月 6 日到期……', time: '3 小时前', unread: false, avatar: 'IT', color: '#ef4444' },
  { from: '王同学', subject: '组队需要：CSCI 540 期末 project', snippet: '看到你也在选这门课，方便的话我们组个队？我这边已经有两个人……', time: '4 小时前', unread: false, avatar: '王', color: '#f59e0b', att: true }
]

const LAYOUT = (title, bodyClass, extraHead, extraBody) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body { font-size: 13px; -webkit-font-smoothing: antialiased; overflow: hidden; }
  button { font: inherit; border: 0; background: none; cursor: pointer; color: inherit; }
  .app { display: grid; grid-template-columns: 224px 336px 1fr; height: 100vh; }
  /* sidebar */
  .brand { display: flex; align-items: center; gap: 9px; margin-bottom: 14px; }
  .logo { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; font-weight: 800; color: #fff; font-size: 13px; background: linear-gradient(135deg, #2f6fed, #22c1a4); }
  .brand-name { font-weight: 700; font-size: 13.5px; }
  .brand-sub { font-size: 10.5px; opacity: 0.55; }
  .account { display: flex; align-items: center; gap: 7px; font-size: 11px; padding: 6px 8px; margin-bottom: 14px; }
  .account .dot { width: 6px; height: 6px; border-radius: 50%; background: #2f9e6e; }
  .nav-label { font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; opacity: 0.45; padding: 10px 8px 4px; }
  .nav-item { display: flex; align-items: center; gap: 9px; padding: 7px 9px; font-size: 12.5px; border-radius: 8px; }
  .nav-item .ico { width: 16px; text-align: center; }
  .nav-item .count { margin-left: auto; font-size: 10.5px; opacity: 0.55; }
  .nav-item.active { font-weight: 600; }
  /* list */
  .list-head { padding: 14px 14px 8px; }
  .list-title { font-size: 15px; font-weight: 700; display: flex; align-items: baseline; gap: 8px; }
  .list-title .sub { font-size: 10.5px; opacity: 0.55; font-weight: 400; }
  .search { margin-top: 10px; display: flex; align-items: center; gap: 7px; padding: 8px 11px; font-size: 12px; opacity: 0.7; }
  .rows { padding: 2px 8px 12px; overflow: hidden; }
  .row { display: flex; gap: 10px; padding: 10px 10px; border-radius: 10px; margin-bottom: 2px; }
  .avatar { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-size: 11.5px; font-weight: 700; flex: none; }
  .row-main { min-width: 0; flex: 1; }
  .row-top { display: flex; align-items: baseline; gap: 6px; }
  .row-from { font-size: 12px; font-weight: 700; }
  .row-time { margin-left: auto; font-size: 10px; opacity: 0.5; flex: none; }
  .row-subject { font-size: 12.5px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row-snippet { font-size: 11.5px; opacity: 0.6; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row-meta { display: flex; gap: 6px; margin-top: 5px; }
  .mini { font-size: 10px; padding: 1px 6px; border-radius: 999px; }
  .row.unread .row-subject { font-weight: 700; }
  /* detail */
  .detail { overflow: hidden; display: flex; flex-direction: column; }
  .detail-head { padding: 18px 24px 14px; }
  .detail-title { font-size: 20px; font-weight: 700; letter-spacing: 0.2px; }
  .detail-meta { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
  .detail-meta .who { font-size: 12.5px; font-weight: 700; }
  .detail-meta .mail { font-size: 11px; opacity: 0.55; }
  .detail-meta .time { margin-left: auto; font-size: 11px; opacity: 0.5; }
  .toolbar { display: flex; gap: 7px; padding: 0 24px 14px; flex-wrap: wrap; }
  .tool { font-size: 11.5px; padding: 6px 11px; border-radius: 999px; display: inline-flex; gap: 5px; align-items: center; }
  .body { padding: 6px 26px 24px; font-size: 13.5px; line-height: 1.85; overflow: auto; }
  .body p { margin-bottom: 10px; }
  .attach { display: flex; gap: 8px; margin-top: 16px; }
  .file { font-size: 11.5px; padding: 8px 11px; border-radius: 9px; display: inline-flex; gap: 6px; align-items: center; }
  ${extraHead}
</style></head>
<body class="${bodyClass}">
<div class="app">
  <aside class="sidebar">
    <div class="brand"><div class="logo">H</div><div><div class="brand-name">HHmail</div><div class="brand-sub">收信只读 · 支持发信 · AI 摘要</div></div></div>
    <div class="account"><span class="dot"></span>1155276985@link.cuhk.edu.hk</div>
    <div class="nav-label">邮箱</div>
    <div class="nav-item active"><span class="ico">📥</span>收件箱<span class="count">12</span></div>
    <div class="nav-item"><span class="ico">✨</span>AI 助手</div>
    <div class="nav-item"><span class="ico">✏️</span>草稿箱</div>
    <div class="nav-item"><span class="ico">📚</span>知识库</div>
    <div class="nav-item"><span class="ico">🗓</span>日历</div>
    <div class="nav-item"><span class="ico">☑️</span>待办</div>
    <div class="nav-item"><span class="ico">↗</span>已发送</div>
    <div class="nav-label">类别</div>
    <div class="nav-item"><span class="ico">⭐</span>星标</div>
    <div class="nav-item"><span class="ico">🚩</span>红旗</div>
    ${extraBody.sidebar}
  </aside>

  <section class="list-pane">
    <div class="list-head">
      <div class="list-title">收件箱 <span class="sub">12 封未读</span></div>
      <div class="search"><span>🔍</span><span>搜索邮件…（主题 / 正文 / 发件人）</span></div>
    </div>
    <div class="rows">
      ${mails.map((m) => `
      <div class="row ${m === mails[0] ? 'selected' : ''} ${m.unread ? 'unread' : ''}">
        <div class="avatar" style="background:${m.color}">${m.avatar}</div>
        <div class="row-main">
          <div class="row-top"><span class="row-from">${m.from}</span><span class="row-time">${m.time}</span></div>
          <div class="row-subject">${m.subject}</div>
          <div class="row-snippet">${m.snippet}</div>
          <div class="row-meta">${m.att ? '<span class="mini">📎 附件</span>' : ''}<span class="mini">${m.from.split(' ')[0]}</span></div>
        </div>
      </div>`).join('')}
    </div>
  </section>

  <section class="detail">
    <div class="detail-head">
      <div class="detail-title">关于毕业论文进度的沟通</div>
      <div class="detail-meta">
        <div class="avatar" style="background:#3b82f6">林</div>
        <div><div class="who">Prof. 林教授</div><div class="mail">lin@link.cuhk.edu.hk</div></div>
        <div class="time">2026 年 11 月 3 日（周一）10:53</div>
      </div>
    </div>
    <div class="toolbar">
      <span class="tool">⭐ 星标</span><span class="tool">🏷 类别</span><span class="tool">🚩 红旗</span>
      <span class="tool">🔖 标签</span><span class="tool">⏰ 稍后提醒</span><span class="tool">✨ AI 总结</span>
      <span class="tool">↩ 回复</span><span class="tool">↪ 转发</span><span class="tool">☑ 加入待办</span>
    </div>
    <div class="body">
      <p>这是第 1 封测试邮件的内容摘要，用于验证列表渲染与搜索。</p>
      <p>长正文第 1 行：用于验证详情区滚动。长正文第 2 行：用于验证详情区滚动。长正文第 3 行：用于验证详情区滚动。</p>
      <p>长正文第 4 行：用于验证详情区滚动。长正文第 5 行：用于验证详情区滚动。</p>
      ${extraBody.afterBody}
    </div>
  </section>
</div>
</body></html>`

// ---------- 1) Apple 原生风（apple-hig） ----------
const apple = {
  bodyClass: 's-apple',
  head: `
  body.s-apple { background: #f5f5f7; color: #1d1d1f; font-family: -apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .s-apple .app { gap: 12px; padding: 12px; }
  .s-apple .sidebar, .s-apple .list-pane, .s-apple .detail { background: #fff; border-radius: 18px; border: 1px solid #e5e5ea; }
  .s-apple .sidebar { padding: 16px 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .s-apple .list-pane { display: flex; flex-direction: column; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .s-apple .detail { box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .s-apple .logo { background: linear-gradient(135deg, #0a84ff, #64d2ff); border-radius: 9px; }
  .s-apple .nav-item { border-radius: 9px; }
  .s-apple .nav-item.active { background: rgba(0, 113, 227, 0.1); color: #0071e3; }
  .s-apple .search { background: #f5f5f7; border-radius: 10px; }
  .s-apple .row { border-radius: 12px; }
  .s-apple .row.selected { background: rgba(0, 113, 227, 0.08); }
  .s-apple .row:hover { background: #f5f5f7; }
  .s-apple .row-time, .s-apple .row-snippet { color: #86868b; }
  .s-apple .mini { background: #f5f5f7; color: #6e6e73; }
  .s-apple .detail-title { font-size: 22px; letter-spacing: 0.1px; }
  .s-apple .tool { background: #f5f5f7; color: #1d1d1f; }
  .s-apple .file { background: #f5f5f7; border: 1px solid #e5e5ea; }
  .s-apple .body { color: #1d1d1f; }
  .s-apple .accent-link { color: #0071e3; }
  `,
  body: {
    sidebar: `<div class="nav-label">标签</div><div class="nav-item"><span class="ico">🔵</span>Blue<span class="count">0</span></div><div class="nav-item"><span class="ico">🟢</span>Green<span class="count">0</span></div>`,
    afterBody: `
      <div class="attach"><span class="file">📎 论文时间表.xlsx</span><span class="file">📎 初稿模板.docx</span></div>
      <p style="margin-top:18px;font-size:12px;opacity:0.55">— 收信只读，不会把服务器邮件标记为已读 —</p>`
  }
}

// ---------- 2) Linear 深色工具风 ----------
const linear = {
  bodyClass: 's-linear',
  head: `
  body.s-linear { background: #08090a; color: #f7f8f8; font-family: "Inter Tight", "Inter", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .s-linear .app { grid-template-columns: 212px 320px 1fr; }
  .s-linear .sidebar { border-right: 1px solid rgba(255,255,255,0.06); padding: 14px 10px; }
  .s-linear .list-pane { border-right: 1px solid rgba(255,255,255,0.06); display: flex; flex-direction: column; }
  .s-linear .brand-name { font-weight: 600; letter-spacing: -0.01em; }
  .s-linear .logo { background: linear-gradient(135deg, #5e6ad2, #8b7cf6); border-radius: 6px; }
  .s-linear .account { color: #9ca3af; }
  .s-linear .nav-label { color: #6b7280; }
  .s-linear .nav-item { border-radius: 6px; color: #9ca3af; }
  .s-linear .nav-item.active { background: #16171c; color: #f7f8f8; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06); }
  .s-linear .nav-item .count { color: #5e6ad2; }
  .s-linear .list-title { font-weight: 600; letter-spacing: -0.01em; }
  .s-linear .search { background: #16171c; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; color: #6b7280; }
  .s-linear .row { border-radius: 8px; }
  .s-linear .row.selected { background: #16171c; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08); }
  .s-linear .row:hover { background: #121318; }
  .s-linear .row-from { color: #f7f8f8; font-weight: 500; }
  .s-linear .row-time { color: #6b7280; }
  .s-linear .row-snippet { color: #6b7280; }
  .s-linear .mini { background: #1e1f25; color: #9ca3af; }
  .s-linear .avatar { border-radius: 7px; font-size: 10.5px; }
  .s-linear .detail { background: #0b0c0e; }
  .s-linear .detail-title { font-size: 19px; font-weight: 600; letter-spacing: -0.02em; }
  .s-linear .detail-meta .mail, .s-linear .detail-meta .time { color: #6b7280; }
  .s-linear .tool { background: #16171c; border: 1px solid rgba(255,255,255,0.06); color: #9ca3af; border-radius: 6px; }
  .s-linear .tool:hover { color: #f7f8f8; }
  .s-linear .body { color: #c9ccd3; font-size: 13.5px; line-height: 1.7; max-width: 820px; }
  .s-linear .file { background: #16171c; border: 1px solid rgba(255,255,255,0.06); color: #9ca3af; border-radius: 6px; }
  .s-linear .kbd { font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; color: #a78bfa; background: #1e1f25; padding: 2px 5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.06); }
  `,
  body: {
    sidebar: `<div class="nav-label">标签</div><div class="nav-item"><span class="ico">●</span>Blue<span class="count">0</span></div><div class="nav-item"><span class="ico">●</span>Green<span class="count">0</span></div><div style="margin-top:16px;padding:8px 9px;color:#6b7280;font-size:10.5px">快捷键 <span class="kbd">⌘K</span> <span class="kbd">⌘J</span></div>`,
    afterBody: `
      <div class="attach"><span class="file">📎 论文时间表.xlsx</span><span class="file">📎 初稿模板.docx</span></div>`
  }
}

// ---------- 3) Notion 暖白极简风 ----------
const notion = {
  bodyClass: 's-notion',
  head: `
  body.s-notion { background: #ffffff; color: #37352f; font-family: "Inter", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .s-notion .app { grid-template-columns: 228px 340px 1fr; }
  .s-notion .sidebar { background: #f7f6f3; padding: 16px 12px; border-right: 1px solid #e9e9e7; }
  .s-notion .list-pane { border-right: 1px solid #e9e9e7; display: flex; flex-direction: column; }
  .s-notion .list-title { font-family: Georgia, "Songti SC", "SimSun", serif; font-size: 17px; font-weight: 600; letter-spacing: 0.1px; }
  .s-notion .logo { background: #37352f; border-radius: 7px; }
  .s-notion .account { color: #787774; }
  .s-notion .nav-label { color: #a8a29e; }
  .s-notion .nav-item { border-radius: 6px; color: #37352f; }
  .s-notion .nav-item.active { background: rgba(55, 53, 47, 0.08); }
  .s-notion .search { background: #f7f6f3; border: 1px solid #e9e9e7; border-radius: 8px; color: #787774; }
  .s-notion .row { border-radius: 8px; padding: 11px 10px; }
  .s-notion .row.selected { background: #f7f6f3; box-shadow: inset 0 0 0 1px #e9e9e7; }
  .s-notion .row:hover { background: #faf9f8; }
  .s-notion .row-snippet, .s-notion .row-time { color: #787774; }
  .s-notion .mini { background: #f7f6f3; border: 1px solid #e9e9e7; color: #787774; }
  .s-notion .avatar { border-radius: 8px; }
  .s-notion .detail-title { font-family: Georgia, "Songti SC", "SimSun", serif; font-size: 26px; font-weight: 600; letter-spacing: 0.2px; }
  .s-notion .tool { background: #ffffff; border: 1px solid #e9e9e7; color: #37352f; border-radius: 7px; box-shadow: 0 1px 2px rgba(15,15,15,0.03); }
  .s-notion .body { font-size: 14px; line-height: 1.85; color: #37352f; }
  .s-notion .file { background: #f7f6f3; border: 1px solid #e9e9e7; color: #37352f; border-radius: 7px; }
  .s-notion .soft { background: #fef3c7; border-radius: 6px; padding: 1px 6px; }
  `,
  body: {
    sidebar: `<div class="nav-label">标签</div><div class="nav-item"><span class="ico">🟦</span>Blue<span class="count">0</span></div><div class="nav-item"><span class="ico">🟩</span>Green<span class="count">0</span></div>`,
    afterBody: `
      <div class="attach"><span class="file">📎 论文时间表.xlsx</span><span class="file">📎 初稿模板.docx</span></div>
      <p style="margin-top:20px;padding:12px 14px;background:#f7f6f3;border-radius:8px;font-size:12.5px;color:#787774">📌 提示：下周三前把初稿发我看看</p>`
  }
}

// ---------- 4) 纸张/编辑风（Stripe Press 暖色 + 衬线） ----------
const paper = {
  bodyClass: 's-paper',
  head: `
  body.s-paper { background: #faf6ef; color: #1f1b16; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .s-paper .app { gap: 14px; padding: 14px; grid-template-columns: 220px 344px 1fr; }
  .s-paper .sidebar { background: #f3ede2; border-radius: 4px; padding: 16px 12px; border: 1px solid #e6ddcc; }
  .s-paper .list-pane { background: #fffdf8; border-radius: 4px; border: 1px solid #e6ddcc; display: flex; flex-direction: column; }
  .s-paper .detail { background: #fffdf8; border-radius: 4px; border: 1px solid #e6ddcc; }
  .s-paper .logo { background: #1f1b16; border-radius: 2px; }
  .s-paper .brand-name { font-family: Georgia, "Songti SC", "SimSun", serif; font-size: 15px; letter-spacing: 0.3px; }
  .s-paper .nav-label { color: #9a8f7f; }
  .s-paper .nav-item { border-radius: 3px; color: #3d362c; }
  .s-paper .nav-item.active { background: #e9dfcd; font-weight: 600; }
  .s-paper .search { background: #f6f0e6; border: 1px solid #e6ddcc; border-radius: 3px; color: #8a7f6d; }
  .s-paper .list-title { font-family: Georgia, "Songti SC", "SimSun", serif; font-size: 18px; letter-spacing: 0.3px; }
  .s-paper .row { border-radius: 3px; padding: 11px 10px; border-bottom: 1px solid #efe7d9; }
  .s-paper .row.selected { background: #f6f0e6; }
  .s-paper .row:hover { background: #faf5ec; }
  .s-paper .row-from { color: #1f1b16; }
  .s-paper .row-snippet, .s-paper .row-time { color: #8a7f6d; }
  .s-paper .mini { background: #f1e8d9; color: #8a7f6d; border-radius: 2px; }
  .s-paper .avatar { border-radius: 3px; }
  .s-paper .detail-title { font-family: Georgia, "Songti SC", "SimSun", serif; font-size: 27px; font-weight: 600; letter-spacing: 0.3px; line-height: 1.35; }
  .s-paper .detail-head { border-bottom: 1px solid #efe7d9; }
  .s-paper .tool { background: #fffdf8; border: 1px solid #e6ddcc; color: #3d362c; border-radius: 2px; }
  .s-paper .body { font-size: 14px; line-height: 1.9; color: #2b241c; font-family: Georgia, "Songti SC", "SimSun", serif; }
  .s-paper .file { background: #f6f0e6; border: 1px solid #e6ddcc; color: #3d362c; border-radius: 2px; }
  .s-paper .rule { height: 1px; background: #e6ddcc; margin: 16px 0; }
  `,
  body: {
    sidebar: `<div class="nav-label">标签</div><div class="nav-item"><span class="ico">▪</span>Blue<span class="count">0</span></div><div class="nav-item"><span class="ico">▪</span>Green<span class="count">0</span></div>`,
    afterBody: `
      <div class="rule"></div>
      <div class="attach"><span class="file">📎 论文时间表.xlsx</span><span class="file">📎 初稿模板.docx</span></div>`
  }
}

// ---------- 5) 玻璃拟态风（Arc-like） ----------
const glass = {
  bodyClass: 's-glass',
  head: `
  body.s-glass { color: #eef2ff; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #0b0f1a; }
  body.s-glass::before { content: ''; position: fixed; inset: -20%; background:
    radial-gradient(600px 420px at 12% 8%, rgba(124, 58, 237, 0.55), transparent 60%),
    radial-gradient(560px 420px at 88% 12%, rgba(6, 182, 212, 0.5), transparent 62%),
    radial-gradient(700px 520px at 60% 100%, rgba(236, 72, 153, 0.42), transparent 60%),
    #0b0f1a; filter: blur(30px); z-index: -1; }
  .s-glass .app { gap: 14px; padding: 14px; grid-template-columns: 218px 336px 1fr; position: relative; }
  .s-glass .sidebar, .s-glass .list-pane, .s-glass .detail {
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14);
    border-radius: 20px; backdrop-filter: blur(22px) saturate(140%);
    box-shadow: 0 20px 60px rgba(0,0,0,0.35);
  }
  .s-glass .sidebar { padding: 16px 12px; }
  .s-glass .list-pane { display: flex; flex-direction: column; }
  .s-glass .brand-name { font-weight: 700; }
  .s-glass .brand-sub { color: rgba(238,242,255,0.55); }
  .s-glass .account { background: rgba(255,255,255,0.07); border-radius: 10px; color: rgba(238,242,255,0.8); }
  .s-glass .nav-label { color: rgba(238,242,255,0.45); }
  .s-glass .nav-item { border-radius: 10px; color: rgba(238,242,255,0.82); }
  .s-glass .nav-item.active { background: rgba(255,255,255,0.16); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.2); font-weight: 600; }
  .s-glass .logo { background: linear-gradient(135deg, #7c3aed, #06b6d4); border-radius: 9px; box-shadow: 0 6px 18px rgba(124,58,237,0.5); }
  .s-glass .search { background: rgba(255,255,255,0.09); border: 1px solid rgba(255,255,255,0.16); border-radius: 999px; color: rgba(238,242,255,0.6); }
  .s-glass .row { border-radius: 14px; }
  .s-glass .row.selected { background: rgba(255,255,255,0.14); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.22); }
  .s-glass .row:hover { background: rgba(255,255,255,0.08); }
  .s-glass .row-time, .s-glass .row-snippet { color: rgba(238,242,255,0.55); }
  .s-glass .mini { background: rgba(255,255,255,0.12); color: rgba(238,242,255,0.75); }
  .s-glass .avatar { box-shadow: 0 4px 12px rgba(0,0,0,0.25); }
  .s-glass .detail-title { font-size: 21px; letter-spacing: 0.2px; }
  .s-glass .detail-meta .mail, .s-glass .detail-meta .time { color: rgba(238,242,255,0.55); }
  .s-glass .tool { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.16); border-radius: 999px; color: rgba(238,242,255,0.85); }
  .s-glass .tool:hover { background: rgba(255,255,255,0.18); }
  .s-glass .body { color: rgba(238,242,255,0.86); font-size: 13.5px; line-height: 1.85; }
  .s-glass .file { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.16); border-radius: 10px; }
  .s-glass .glow-pill { display:inline-flex; align-items:center; gap:6px; padding:5px 11px; border-radius:999px; font-size:11.5px; background: linear-gradient(120deg, rgba(124,58,237,0.85), rgba(6,182,212,0.8)); box-shadow: 0 8px 24px rgba(124,58,237,0.4); }
  `,
  body: {
    sidebar: `<div class="nav-label">标签</div><div class="nav-item"><span class="ico">●</span>Blue<span class="count">0</span></div><div class="nav-item"><span class="ico">●</span>Green<span class="count">0</span></div><div style="margin-top:16px"><span class="glow-pill">✨ AI 摘要已开启</span></div>`,
    afterBody: `
      <div class="attach"><span class="file">📎 论文时间表.xlsx</span><span class="file">📎 初稿模板.docx</span></div>`
  }
}

const styles = [
  ['1-apple', 'Apple 原生风（大面积留白 + 系统蓝）', apple],
  ['2-linear', 'Linear 深色工具风（hairline + 紫色点缀）', linear],
  ['3-notion', 'Notion 暖白极简风（衬线大标题 + 米白）', notion],
  ['4-paper', '纸张编辑风（暖纸色 + 衬线排版）', paper],
  ['5-glass', '玻璃拟态（渐变光晕 + 毛玻璃面板）', glass]
]

for (const [id, title, def] of styles) {
  const html = LAYOUT(title, def.bodyClass, def.head, def.body)
  const file = path.join(OUT, `style-${id}.html`)
  fs.writeFileSync(file, html, 'utf8')
  console.log(file)
}

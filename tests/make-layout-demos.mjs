// 生成 5 套「排版架构完全不同」的邮箱 UI demo（不是换皮，是换信息架构）
// 输出：program/docs/design/layouts/layout-N-*.html
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '..', 'docs', 'design', 'layouts')
fs.mkdirSync(OUT, { recursive: true })

const M = [
  { from: 'Prof. 林教授', short: '林', subject: '关于毕业论文进度的沟通', snippet: '附件里是我整理的时间表，下周三前把初稿发我看看。', time: '10:53', unread: true, color: '#3b82f6', att: ['论文时间表.xlsx', '初稿模板.docx'], body: ['老师好，附件里是我整理的时间表，下周三前把初稿发我看看。', '另外第 2 章的结构可以再压缩一些，重点放在实验部分。'] },
  { from: '教务处', short: '教', subject: '【重要】关于选课与学费缴费的通知', snippet: '本学期第二阶段选课将于 11 月 7 日 18:00 截止，请及时确认。', time: '09:20', unread: true, color: '#0ea5e9', att: [], body: ['本学期第二阶段选课将于 11 月 7 日 18:00 截止，请及时确认选课结果。'] },
  { from: '图书馆', short: '图', subject: 'CSE 系周会纪要 & 下周活动安排', snippet: '本周五 15:30 在 SHB 123 举行系周会，会后有茶歇。', time: '昨天', unread: true, color: '#8b5cf6', att: ['周会纪要.pdf'], body: ['本周五 15:30 在 SHB 123 举行系周会。'] },
  { from: 'IT 服务台', short: 'IT', subject: '您借阅的资源即将到期，请及时归还', snippet: '您借阅的《Computer Networks》将于 11 月 6 日到期。', time: '昨天', unread: false, color: '#ef4444', att: [], body: ['您借阅的《Computer Networks》将于 11 月 6 日到期。'] },
  { from: '王同学', short: '王', subject: '组队需要：CSCI 540 期末 project', snippet: '看到你也在选这门课，方便的话我们组个队？', time: '周一', unread: false, color: '#f59e0b', att: [], body: ['看到你也在选这门课，方便的话我们组个队？我这边已经有两个人了。'] }
]

const nav = ['收件箱', 'AI 助手', '草稿箱', '知识库', '日历', '待办', '已发送']
const icon = ['📥', '✨', '✏️', '📚', '🗓', '☑️', '↗']

/* ---------------- L1 聊天式（Twobird / Slack 风） ---------------- */
const L1 = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>L1 聊天式</title><style>
*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f2f3f5;color:#111318;font-size:13px;overflow:hidden}
.app{display:grid;grid-template-columns:64px 300px 1fr;height:100vh}
.rail{background:#1f232b;display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 0}
.rail .logo{width:34px;height:34px;border-radius:11px;background:linear-gradient(135deg,#5b8def,#22c1a4);display:grid;place-items:center;color:#fff;font-weight:800;margin-bottom:10px}
.rail .r{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-size:17px;opacity:.55;color:#fff}
.rail .r.on{background:rgba(255,255,255,.14);opacity:1}
.chats{background:#fff;border-right:1px solid #e6e8ec;display:flex;flex-direction:column}
.chats h2{font-size:16px;padding:18px 16px 10px;display:flex;align-items:center}
.chats h2 .c{margin-left:6px;font-size:11px;color:#fff;background:#3b82f6;border-radius:99px;padding:1px 7px}
.search{margin:0 14px 8px;background:#f2f3f5;border-radius:10px;padding:8px 11px;color:#8a90a0;font-size:12px}
.conv{display:flex;gap:10px;padding:11px 14px;border-radius:12px;margin:1px 8px}
.conv.on{background:#eef4ff}
.conv .av{width:38px;height:38px;border-radius:13px;display:grid;place-items:center;color:#fff;font-weight:700;flex:none}
.conv .mn{min-width:0;flex:1}
.conv .top{display:flex;gap:6px;align-items:baseline}
.conv .nm{font-weight:700;font-size:13px}
.conv .tm{margin-left:auto;font-size:10.5px;color:#9aa1b0}
.conv .pv{font-size:12px;color:#6b7280;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conv .dot{width:7px;height:7px;border-radius:50%;background:#3b82f6;margin-top:6px;flex:none}
.chat{display:flex;flex-direction:column;background:#f7f8fa}
.chat-head{height:60px;display:flex;align-items:center;gap:10px;padding:0 22px;background:#fff;border-bottom:1px solid #e6e8ec}
.chat-head .av{width:32px;height:32px;border-radius:10px;background:#3b82f6;display:grid;place-items:center;color:#fff;font-weight:700}
.chat-head .t{font-weight:700;font-size:13.5px}
.chat-head .s{font-size:11px;color:#8a90a0}
.chat-head .acts{margin-left:auto;display:flex;gap:8px}
.chat-head .acts span{width:30px;height:30px;border-radius:9px;background:#f2f3f5;display:grid;place-items:center;font-size:13px}
.msgs{flex:1;overflow:auto;padding:20px 24px;display:flex;flex-direction:column;gap:14px}
.msg{max-width:74%}
.msg.in .bub{background:#fff;border:1px solid #e6e8ec;border-radius:16px 16px 16px 6px}
.msg.out{align-self:flex-end}
.msg.out .bub{background:#d8e7ff;border-radius:16px 16px 6px 16px}
.bub{padding:12px 14px;font-size:13px;line-height:1.75}
.bub .subj{font-weight:700;margin-bottom:6px}
.bub .att{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}
.bub .att span{font-size:11px;background:rgba(0,0,0,.05);border-radius:7px;padding:5px 9px}
.meta{font-size:10.5px;color:#9aa1b0;margin:5px 2px}
.msg.out .meta{text-align:right}
.composer{margin:0 22px 18px;background:#fff;border:1px solid #e6e8ec;border-radius:16px;padding:12px 14px;display:flex;align-items:center;gap:10px;color:#9aa1b0;font-size:12.5px}
.composer .sp{flex:1}
.composer .btn{background:#3b82f6;color:#fff;border-radius:9px;padding:6px 12px;font-size:12px;font-weight:600}
</style></head><body><div class="app">
<div class="rail"><div class="logo">H</div>${icon.map((i, k) => `<div class="r ${k === 0 ? 'on' : ''}">${i}</div>`).join('')}</div>
<aside class="chats"><h2>收件箱<span class="c">3</span></h2><div class="search">🔍 搜索会话…</div>
${M.map((m, i) => `<div class="conv ${i === 0 ? 'on' : ''}"><div class="av" style="background:${m.color}">${m.short}</div><div class="mn"><div class="top"><span class="nm">${m.from}</span><span class="tm">${m.time}</span></div><div class="pv">${m.snippet}</div></div>${m.unread ? '<div class="dot"></div>' : ''}</div>`).join('')}
</aside>
<section class="chat">
  <div class="chat-head"><div class="av">林</div><div><div class="t">Prof. 林教授</div><div class="s">关于毕业论文进度的沟通 · 3 封</div></div><div class="acts"><span>⭐</span><span>☑</span><span>⋯</span></div></div>
  <div class="msgs">
    <div class="msg in"><div class="bub"><div class="subj">关于毕业论文进度的沟通</div>${M[0].body[0]}<div class="att">${M[0].att.map((a) => `<span>📎 ${a}</span>`).join('')}</div></div><div class="meta">Prof. 林教授 · 今天 10:53</div></div>
    <div class="msg out"><div class="bub">收到老师，时间表我看了。第 2 章我会压缩，周三前把初稿发您邮箱。</div><div class="meta">我 · 今天 11:20</div></div>
    <div class="msg in"><div class="bub">好的，另外实验部分的数据图记得加上误差线。</div><div class="meta">Prof. 林教授 · 今天 11:32</div></div>
  </div>
  <div class="composer"><span>回复 Prof. 林教授…</span><span class="sp"></span><span>📎</span><span class="btn">发送</span></div>
</section></div></body></html>`

/* ---------------- L2 卡片流（Feed 风） ---------------- */
const L2 = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>L2 卡片流</title><style>
*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f4f5f7;color:#15171c;font-size:13px;overflow:hidden}
.top{height:58px;background:#fff;border-bottom:1px solid #e7e9ee;display:flex;align-items:center;gap:10px;padding:0 22px}
.top .logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#6f8cff,#22c1a4);display:grid;place-items:center;color:#fff;font-weight:800}
.top .bn{font-weight:700;font-size:14px}
.top .nav{display:flex;gap:4px;margin-left:20px}
.top .nav span{padding:6px 12px;border-radius:99px;font-size:12.5px;color:#5b6270}
.top .nav span.on{background:#eef2ff;color:#3b5bdb;font-weight:600}
.top .sr{margin-left:auto;background:#f2f3f5;border-radius:99px;padding:8px 14px;color:#8a90a0;font-size:12px;min-width:260px}
.feed{max-width:760px;margin:0 auto;height:calc(100vh - 58px);overflow:auto;padding:18px 20px 40px}
.bar{display:flex;gap:8px;margin-bottom:14px}
.bar .c{padding:6px 13px;border-radius:99px;background:#fff;border:1px solid #e7e9ee;font-size:12px;color:#5b6270}
.bar .c.on{background:#15171c;color:#fff;border-color:#15171c;font-weight:600}
.card{background:#fff;border:1px solid #e7e9ee;border-radius:18px;padding:18px 20px;margin-bottom:14px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.card .hd{display:flex;align-items:center;gap:10px}
.card .av{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;color:#fff;font-weight:700;font-size:12px}
.card .who{font-weight:700;font-size:12.5px}
.card .tm{font-size:11px;color:#9aa1b0}
.card .tg{margin-left:auto;font-size:10.5px;padding:3px 9px;border-radius:99px;background:#eef2ff;color:#3b5bdb;font-weight:600}
.card h3{font-size:19px;font-weight:750;letter-spacing:-.2px;margin:12px 0 8px;line-height:1.35}
.card p{color:#4a505c;line-height:1.7;font-size:13px}
.card .bd{margin-top:10px;padding:12px 14px;background:#f7f8fa;border-radius:12px;font-size:12.5px;line-height:1.75;color:#3d434f}
.card .att{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.card .att span{font-size:11px;background:#f2f3f5;border-radius:9px;padding:6px 10px;color:#4a505c}
.card .acts{display:flex;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid #f0f1f4}
.card .acts span{font-size:11.5px;padding:5px 11px;border-radius:9px;background:#f7f8fa;color:#4a505c}
.card .acts span.p{background:#15171c;color:#fff;font-weight:600}
.card.fold h3{font-size:16px;margin:10px 0 6px}
.card.fold p{color:#6b7280;font-size:12.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card.unread{box-shadow:0 1px 2px rgba(16,24,40,.04),inset 3px 0 0 #3b82f6}
</style></head><body>
<div class="top"><div class="logo">H</div><div class="bn">HHmail</div><div class="nav">${nav.map((n, i) => `<span class="${i === 0 ? 'on' : ''}">${n}</span>`).join('')}</div><div class="sr">🔍 搜索邮件、联系人…</div></div>
<div class="feed">
  <div class="bar"><span class="c on">全部</span><span class="c">未读 3</span><span class="c">有附件</span><span class="c">重要</span><span class="c">已归档</span></div>
  <div class="card unread">
    <div class="hd"><div class="av" style="background:#3b82f6">林</div><div><div class="who">Prof. 林教授</div><div class="tm">今天 10:53 · 收件箱</div></div><span class="tg">论文</span></div>
    <h3>关于毕业论文进度的沟通</h3><p>附件里是我整理的时间表，下周三前把初稿发我看看。</p>
    <div class="bd">${M[0].body.join('<br>')}</div>
    <div class="att">${M[0].att.map((a) => `<span>📎 ${a}</span>`).join('')}</div>
    <div class="acts"><span class="p">↩ 回复</span><span>⭐ 星标</span><span>☑ 加入待办</span><span>✨ AI 总结</span><span>⋯</span></div>
  </div>
  ${M.slice(1).map((m) => `<div class="card fold ${m.unread ? 'unread' : ''}"><div class="hd"><div class="av" style="background:${m.color}">${m.short}</div><div><div class="who">${m.from}</div><div class="tm">${m.time} · 收件箱</div></div><span class="tg">${m.att.length ? '附件' : '通知'}</span></div><h3>${m.subject}</h3><p>${m.snippet}</p></div>`).join('')}
</div></body></html>`

/* ---------------- L3 看板（Kanban） ---------------- */
const L3 = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>L3 看板</title><style>
*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#15171c;font-size:13px;overflow:hidden}
.side{position:fixed;left:0;top:0;bottom:0;width:212px;background:#fff;border-right:1px solid #e7e9ee;padding:16px 12px}
.brand{display:flex;gap:8px;align-items:center;margin-bottom:16px}
.brand .logo{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#6f8cff,#22c1a4);display:grid;place-items:center;color:#fff;font-weight:800}
.brand b{font-size:13.5px}
.ni{display:flex;gap:9px;align-items:center;padding:8px 10px;border-radius:9px;font-size:12.5px;color:#4a505c}
.ni.on{background:#eef2ff;color:#3b5bdb;font-weight:600}
.main{margin-left:212px;height:100vh;display:flex;flex-direction:column}
.top{height:60px;display:flex;align-items:center;gap:10px;padding:0 22px;border-bottom:1px solid #e7e9ee;background:#fbfbfd}
.top h1{font-size:17px;font-weight:750}
.top .hint{font-size:11.5px;color:#8a90a0}
.top .seg{margin-left:auto;display:flex;background:#eef0f4;border-radius:10px;padding:3px}
.top .seg span{padding:5px 12px;border-radius:8px;font-size:12px;color:#5b6270}
.top .seg span.on{background:#fff;font-weight:600;color:#15171c;box-shadow:0 1px 2px rgba(16,24,40,.08)}
.board{flex:1;display:grid;grid-template-columns:repeat(4,1fr);gap:14px;padding:18px 22px 24px;overflow:hidden}
.col{background:#eff1f5;border-radius:16px;display:flex;flex-direction:column;min-height:0;padding:12px 10px}
.col .ch{display:flex;align-items:center;gap:8px;padding:2px 6px 10px;font-size:12.5px;font-weight:700}
.col .ch .c{margin-left:auto;font-size:10.5px;background:#fff;border-radius:99px;padding:1px 7px;color:#6b7280}
.col .ch .bar{width:8px;height:8px;border-radius:99px}
.col .body{overflow:auto;display:flex;flex-direction:column;gap:9px}
.card{background:#fff;border:1px solid #e7e9ee;border-radius:12px;padding:11px 12px;box-shadow:0 1px 2px rgba(16,24,40,.04);cursor:grab}
.card .hd{display:flex;gap:9px;align-items:center}
.card .av{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;color:#fff;font-size:11px;font-weight:700;flex:none}
.card .who{font-size:11.5px;font-weight:700}
.card .tm{margin-left:auto;font-size:10px;color:#9aa1b0}
.card .sub{font-size:12.5px;font-weight:600;margin:8px 0 4px;line-height:1.4}
.card .sn{font-size:11.5px;color:#6b7280;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card .tags{display:flex;gap:5px;margin-top:9px;flex-wrap:wrap}
.card .tags span{font-size:10px;padding:2px 7px;border-radius:99px;background:#f2f3f5;color:#6b7280}
.card .tags .w{background:#fff4e5;color:#b45309;font-weight:600}
.card .tags .d{background:#fee2e2;color:#b91c1c;font-weight:600}
.empty{border:1.5px dashed #d5d9e0;border-radius:12px;padding:18px 10px;text-align:center;font-size:11.5px;color:#9aa1b0}
</style></head><body>
<aside class="side"><div class="brand"><div class="logo">H</div><b>HHmail</b></div>${nav.map((n, i) => `<div class="ni ${i === 0 ? 'on' : ''}"><span>${icon[i]}</span>${n}</div>`).join('')}</aside>
<div class="main">
  <div class="top"><h1>邮件看板</h1><span class="hint">拖动卡片改变处理状态（待处理 / 等待回复 / 稍后 / 已归档）</span><div class="seg"><span class="on">看板</span><span>列表</span></div></div>
  <div class="board">
    <div class="col"><div class="ch"><span class="bar" style="background:#3b82f6"></span>待处理<span class="c">3</span></div><div class="body">
      <div class="card"><div class="hd"><div class="av" style="background:#3b82f6">林</div><div class="who">Prof. 林教授</div><div class="tm">10:53</div></div><div class="sub">关于毕业论文进度的沟通</div><div class="sn">附件里是我整理的时间表，下周三前把初稿发我看看。</div><div class="tags"><span class="w">周三截止</span><span>📎 2</span></div></div>
      <div class="card"><div class="hd"><div class="av" style="background:#0ea5e9">教</div><div class="who">教务处</div><div class="tm">09:20</div></div><div class="sub">【重要】关于选课与学费缴费的通知</div><div class="sn">第二阶段选课 11 月 7 日 18:00 截止。</div><div class="tags"><span class="d">今天截止</span></div></div>
      <div class="card"><div class="hd"><div class="av" style="background:#f59e0b">王</div><div class="who">王同学</div><div class="tm">周一</div></div><div class="sub">组队需要：CSCI 540 期末 project</div><div class="sn">方便的话我们组个队？</div><div class="tags"><span>回复</span></div></div>
    </div></div>
    <div class="col"><div class="ch"><span class="bar" style="background:#f59e0b"></span>等待回复<span class="c">1</span></div><div class="body">
      <div class="card"><div class="hd"><div class="av" style="background:#8b5cf6">图</div><div class="who">图书馆</div><div class="tm">昨天</div></div><div class="sub">CSE 系周会纪要 & 下周活动安排</div><div class="sn">本周五 15:30 SHB 123。</div><div class="tags"><span>周五</span></div></div>
    </div></div>
    <div class="col"><div class="ch"><span class="bar" style="background:#8b5cf6"></span>稍后<span class="c">1</span></div><div class="body">
      <div class="card"><div class="hd"><div class="av" style="background:#ef4444">IT</div><div class="who">IT 服务台</div><div class="tm">昨天</div></div><div class="sub">您借阅的资源即将到期</div><div class="sn">《Computer Networks》11 月 6 日到期。</div><div class="tags"><span>无截止</span></div></div>
    </div></div>
    <div class="col"><div class="ch"><span class="bar" style="background:#9aa1b0"></span>已归档<span class="c">0</span></div><div class="body"><div class="empty">把处理完的邮件拖到这里</div></div></div>
  </div>
</div></body></html>`

/* ---------------- L4 终端（高密度表格） ---------------- */
const L4 = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>L4 终端</title><style>
*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%}
body{font-family:"Cascadia Mono",Consolas,"JetBrains Mono",ui-monospace,monospace;background:#0b0c0e;color:#d6d9e0;font-size:12.5px;overflow:hidden}
.cmd{height:40px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid #1c1f26;background:#0e1013}
.cmd .p{color:#5eead4}
.cmd .q{color:#8b93a7}
.cmd .kbd{margin-left:auto;color:#6b7280;font-size:11px}
.cmd .kbd b{color:#a78bfa}
.layout{display:grid;grid-template-columns:58% 1fr;height:calc(100vh - 40px - 24px)}
.table{overflow:auto;border-right:1px solid #1c1f26}
.th,.tr{display:grid;grid-template-columns:18px 128px 1fr 64px 56px;align-items:center;gap:8px;padding:0 10px;height:31px}
.th{position:sticky;top:0;background:#0e1013;border-bottom:1px solid #1c1f26;color:#6b7280;font-size:11px;letter-spacing:.4px}
.tr{color:#c3c8d2;border-bottom:1px solid #14171d}
.tr:nth-child(odd){background:#0d0f12}
.tr.sel{background:#16213a;color:#e8ebf2;box-shadow:inset 2px 0 0 #5b8def}
.tr .st{color:#5b8def}
.tr .un{color:#5b8def}
.tr .fr{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tr .sj{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tr .at{color:#f0b45a;text-align:center}
.tr .tm{color:#6b7280;text-align:right;font-size:11px}
.pane{overflow:auto;padding:18px 20px}
.pane h2{font-size:15px;font-weight:700;color:#f2f4f8;font-family:-apple-system,"PingFang SC",sans-serif}
.meta2{margin:10px 0 16px;color:#8b93a7;font-size:11.5px;line-height:1.9;border-left:2px solid #1c1f26;padding-left:10px}
.meta2 b{color:#c3c8d2;font-weight:600}
.pane .body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.85;color:#c3c8d2;white-space:pre-wrap}
.pane .att{margin-top:14px;color:#f0b45a;font-size:12px}
.status{height:24px;display:flex;align-items:center;gap:16px;padding:0 16px;border-top:1px solid #1c1f26;background:#0e1013;color:#6b7280;font-size:11px}
.status b{color:#8b93a7}
.status .r{margin-left:auto}
</style></head><body>
<div class="cmd"><span class="p">hhmail&gt;</span><span class="q">搜索邮件…</span><span class="kbd"><b>⌘K</b> 命令 · <b>J/K</b> 移动 · <b>R</b> 回复 · <b>E</b> 归档</span></div>
<div class="layout">
  <div class="table">
    <div class="th"><span></span><span>发件人</span><span>主题</span><span style="text-align:center">附件</span><span style="text-align:right">时间</span></div>
    ${M.map((m, i) => `<div class="tr ${i === 0 ? 'sel' : ''}"><span class="st">${m.unread ? '●' : '○'}</span><span class="fr ${m.unread ? 'un' : ''}">${m.from}</span><span class="sj">${m.subject}</span><span class="at">${m.att.length ? '📎' + m.att.length : '—'}</span><span class="tm">${m.time}</span></div>`).join('')}
  </div>
  <div class="pane">
    <h2>关于毕业论文进度的沟通</h2>
    <div class="meta2"><b>from:</b> Prof. 林教授 &lt;lin@link.cuhk.edu.hk&gt;<br><b>to:</b> me &nbsp;·&nbsp; <b>date:</b> 2026-11-03 10:53<br><b>attach:</b> 论文时间表.xlsx, 初稿模板.docx</div>
    <div class="body">${M[0].body.join('\n\n')}</div>
    <div class="att">📎 论文时间表.xlsx &nbsp; 📎 初稿模板.docx</div>
  </div>
</div>
<div class="status"><span><b>收件箱</b> 12 封 · 未读 3</span><span>已选 1</span><span class="r">同步 10:58 · AI 已就绪 · 只读模式</span></div>
</body></html>`

/* ---------------- L5 仪表盘（统计卡 + 邮件 + 待办一体） ---------------- */
const L5 = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>L5 仪表盘</title><style>
*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f4f6f9;color:#141820;font-size:13px;overflow:hidden}
.side{position:fixed;left:0;top:0;bottom:0;width:210px;background:#fff;border-right:1px solid #e7e9ee;padding:16px 12px}
.brand{display:flex;gap:8px;align-items:center;margin-bottom:18px}
.brand .logo{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#5b8def,#22c1a4);display:grid;place-items:center;color:#fff;font-weight:800}
.brand b{font-size:13.5px}
.ni{display:flex;gap:9px;align-items:center;padding:8px 10px;border-radius:9px;font-size:12.5px;color:#4a505c}
.ni.on{background:#eef2ff;color:#3b5bdb;font-weight:600}
.main{margin-left:210px;height:100vh;overflow:auto;padding:18px 20px 24px}
.hd{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.hd h1{font-size:19px;font-weight:750}
.hd .sub{font-size:12px;color:#8a90a0}
.hd .sr{margin-left:auto;background:#fff;border:1px solid #e7e9ee;border-radius:10px;padding:8px 13px;color:#8a90a0;font-size:12px;min-width:240px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
.stat{background:#fff;border:1px solid #e7e9ee;border-radius:14px;padding:14px 16px}
.stat .k{font-size:11px;color:#8a90a0;letter-spacing:.3px}
.stat .v{font-size:24px;font-weight:800;margin-top:6px;letter-spacing:-.5px}
.stat .d{font-size:11px;color:#8a90a0;margin-top:4px}
.stat.warn .v{color:#b45309}
.stat.blue .v{color:#3b5bdb}
.split{display:grid;grid-template-columns:1.05fr 1fr;gap:14px;align-items:start}
.panel{background:#fff;border:1px solid #e7e9ee;border-radius:14px;overflow:hidden}
.ph{display:flex;align-items:center;gap:8px;padding:13px 15px;border-bottom:1px solid #f0f1f4;font-size:13px;font-weight:700}
.ph .c{margin-left:auto;font-size:11px;color:#8a90a0;font-weight:500}
.mlist{padding:6px 8px}
.mrow{display:flex;gap:10px;padding:10px;border-radius:10px}
.mrow.on{background:#eef4ff}
.mrow .av{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;color:#fff;font-weight:700;font-size:11.5px;flex:none}
.mrow .mn{min-width:0;flex:1}
.mrow .t1{display:flex;gap:8px;align-items:baseline}
.mrow .fr{font-size:12px;font-weight:700}
.mrow .tm{margin-left:auto;font-size:10.5px;color:#9aa1b0}
.mrow .sj{font-size:12.5px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mrow .sn{font-size:11.5px;color:#8a90a0;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.detail{padding:16px 18px}
.detail h2{font-size:19px;font-weight:750;letter-spacing:-.2px;margin-bottom:10px}
.detail .who{display:flex;gap:9px;align-items:center;font-size:12px;color:#8a90a0}
.detail .who .av{width:28px;height:28px;border-radius:9px;background:#3b82f6;display:grid;place-items:center;color:#fff;font-weight:700;font-size:11px}
.detail .body{margin-top:14px;font-size:13px;line-height:1.8;color:#3d434f}
.detail .att{display:flex;gap:8px;margin-top:12px}
.detail .att span{font-size:11px;background:#f4f6f9;border-radius:8px;padding:6px 10px;color:#4a505c}
.todo{margin-top:16px;border-top:1px solid #f0f1f4;padding-top:14px}
.todo .th{font-size:12px;font-weight:700;margin-bottom:8px}
.todo .ti{display:flex;gap:8px;align-items:center;font-size:12.5px;padding:6px 0;color:#3d434f}
.todo .bx{width:15px;height:15px;border-radius:4px;border:1.5px solid #cfd4dc;display:grid;place-items:center;font-size:10px;color:#fff}
.todo .bx.on{background:#2f9e6e;border-color:#2f9e6e}
</style></head><body>
<aside class="side"><div class="brand"><div class="logo">H</div><b>HHmail</b></div>${nav.map((n, i) => `<div class="ni ${i === 0 ? 'on' : ''}"><span>${icon[i]}</span>${n}</div>`).join('')}</aside>
<div class="main">
  <div class="hd"><h1>收件箱总览</h1><span class="sub">2026 年 11 月 3 日 · 周一</span><div class="sr">🔍 搜索邮件…</div></div>
  <div class="stats">
    <div class="stat blue"><div class="k">未读邮件</div><div class="v">12</div><div class="d">比昨天多 3 封</div></div>
    <div class="stat warn"><div class="k">今天到期</div><div class="v">2</div><div class="d">选课确认 · 论文初稿</div></div>
    <div class="stat"><div class="k">待处理邮件</div><div class="v">7</div><div class="d">需要回复 / 加待办</div></div>
    <div class="stat"><div class="k">待办</div><div class="v">4</div><div class="d">1 件已逾期</div></div>
  </div>
  <div class="split">
    <div class="panel"><div class="ph">最近邮件<span class="c">12 封未读</span></div><div class="mlist">
      ${M.map((m, i) => `<div class="mrow ${i === 0 ? 'on' : ''}"><div class="av" style="background:${m.color}">${m.short}</div><div class="mn"><div class="t1"><span class="fr">${m.from}</span><span class="tm">${m.time}</span></div><div class="sj">${m.unread ? '<b>●</b> ' : ''}${m.subject}</div><div class="sn">${m.snippet}</div></div></div>`).join('')}
    </div></div>
    <div class="panel"><div class="ph">邮件详情 + 待办</div><div class="detail">
      <h2>关于毕业论文进度的沟通</h2>
      <div class="who"><div class="av">林</div>Prof. 林教授 · lin@link.cuhk.edu.hk · 今天 10:53</div>
      <div class="body">${M[0].body.join('<br><br>')}</div>
      <div class="att">${M[0].att.map((a) => `<span>📎 ${a}</span>`).join('')}</div>
      <div class="todo"><div class="th">☑ 这封邮件里的待办</div>
        <div class="ti"><span class="bx on">✓</span>整理时间表</div>
        <div class="ti"><span class="bx"></span>压缩第 2 章结构</div>
        <div class="ti"><span class="bx"></span>周三前发初稿给老师</div>
      </div>
    </div></div>
  </div>
</div></body></html>`

const layouts = [
  ['1-chat', 'L1 聊天式（Twobird / Slack 风）', L1],
  ['2-feed', 'L2 卡片流（Feed / 社交风）', L2],
  ['3-kanban', 'L3 看板（Kanban 状态列）', L3],
  ['4-terminal', 'L4 终端表格（Bloomberg / 高密度）', L4],
  ['5-dashboard', 'L5 仪表盘（统计 + 邮件 + 待办一体）', L5]
]
for (const [id, _t, html] of layouts) {
  fs.writeFileSync(path.join(OUT, `layout-${id}.html`), html, 'utf8')
  console.log(path.join(OUT, `layout-${id}.html`))
}

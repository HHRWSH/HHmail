/**
 * 中英跨语言检索词（纯函数）。
 *
 * 真机背景：中文提问、英文语料（学校邮箱的邮件主题大量是英文），例如
 *   问「图书馆相关的邮件」→ 主题是 "Library Orientation"（评测里唯一漏召回的题）；
 *   问「实习或就业」→ 主题是 "Internships and Job Openings"（只能靠"最近邮件"兜底）。
 * 本文件维护一份**校园邮件领域的中英概念表**，命中中文概念就补英文写法、命中英文就补中文写法，
 * 让「关键词 + 结构化过滤」这套零成本方案覆盖跨语言，而不必上向量（见 docs/检索评测.md 的选型结论）。
 *
 * 另外补一类**词级简繁/异体**（字级表格不敢收的歧义字）：注册→註冊、回复→回覆、重複… 
 */

export interface Concept {
  /** 中文写法（简/繁都列上，便于匹配两种提问习惯） */
  zh: string[]
  /** 英文写法（含常见复数/缩写，匹配时允许再加 s/es） */
  en: string[]
}

/** 校园邮件领域概念表：命中任一侧 → 补另一侧（跨语言召回）。 */
export const CONCEPTS: Concept[] = [
  { zh: ['图书馆', '圖書館', '图书', '圖書'], en: ['library', 'libraries', 'lib'] },
  { zh: ['学费', '學費'], en: ['tuition', 'fee', 'fees', 'billing'] },
  { zh: ['缴费', '繳費', '付款', '账单', '賬單', '帳單'], en: ['payment', 'pay', 'bill', 'billing', 'fee', 'fees'] },
  { zh: ['奖学金', '獎學金'], en: ['scholarship', 'award', 'grant', 'bursary'] },
  { zh: ['助学金', '助學金', '资助', '資助'], en: ['financial aid', 'subsidy', 'grant', 'bursary'] },
  { zh: ['贷款', '貸款', '借贷', '借貸'], en: ['loan', 'nlsft', 'tsfs'] },
  { zh: ['宿舍', '住宿', '宿位'], en: ['hostel', 'accommodation', 'residence', 'hall'] },
  { zh: ['选课', '選課', '加退选', '加退選'], en: ['course registration', 'course selection', 'enrollment', 'enrolment', 'add/drop'] },
  { zh: ['注册', '註冊'], en: ['registration', 'register', 'enrolment', 'enrollment'] },
  { zh: ['考试', '考試', '测验', '測驗', '期中考', '期末考'], en: ['exam', 'examination', 'quiz', 'midterm', 'test'] },
  { zh: ['作业', '作業', '功课', '功課'], en: ['assignment', 'homework', 'lab', 'exercise'] },
  { zh: ['提交', '递交', '遞交', '上传', '上傳'], en: ['submission', 'submit', 'upload'] },
  { zh: ['截止', '截止日期', '期限'], en: ['deadline', 'due', 'ddl'] },
  { zh: ['讲座', '講座', '研讨会', '研討會'], en: ['seminar', 'lecture', 'talk', 'webinar'] },
  { zh: ['工作坊'], en: ['workshop'] },
  { zh: ['活动', '活動', '节目', '節目'], en: ['event', 'activity', 'programme', 'program'] },
  { zh: ['会议', '會議'], en: ['meeting', 'session', 'conference'] },
  { zh: ['报名', '報名'], en: ['registration', 'sign up', 'apply', 'application'] },
  { zh: ['申请', '申請'], en: ['application', 'apply', 'applications'] },
  { zh: ['实习', '實習'], en: ['internship', 'intern', 'placement', 'traineeship'] },
  { zh: ['就业', '就業', '找工作', '求职', '求職'], en: ['employment', 'career', 'job', 'jobs', 'recruitment'] },
  { zh: ['招聘', '招募', '空缺'], en: ['recruitment', 'hiring', 'vacancy', 'opening', 'openings'] },
  { zh: ['简历', '簡歷', '履历', '履歷'], en: ['cv', 'resume'] },
  { zh: ['面试', '面試'], en: ['interview', 'interviews'] },
  { zh: ['导师', '導師', '指导老师', '指導老師'], en: ['supervisor', 'advisor', 'professor', 'teacher'] },
  { zh: ['论文', '論文', '毕业论文', '畢業論文'], en: ['thesis', 'dissertation', 'paper'] },
  { zh: ['毕业', '畢業'], en: ['graduation', 'graduate', 'commencement'] },
  { zh: ['成绩', '成績', '分数', '分數'], en: ['grade', 'grades', 'result', 'results'] },
  { zh: ['成绩单', '成績單'], en: ['transcript', 'transcripts'] },
  { zh: ['校历', '校曆', '日程'], en: ['academic calendar', 'calendar', 'timetable', 'schedule'] },
  { zh: ['学期', '學期'], en: ['term', 'semester'] },
  { zh: ['课程', '課程', '科目'], en: ['course', 'courses', 'programme', 'program'] },
  { zh: ['通识', '通識'], en: ['general education'] },
  { zh: ['书院', '書院', '学院', '學院'], en: ['college', 'faculty', 'school'] },
  { zh: ['教务处', '教務處', '行政'], en: ['registry', 'academic affairs', 'administrative'] },
  { zh: ['问卷', '問卷', '调查', '調查'], en: ['questionnaire', 'survey'] },
  { zh: ['表格', '表单', '表單'], en: ['form', 'forms'] },
  { zh: ['通知', '公告', '通告'], en: ['notification', 'announcement', 'notice', 'notifications'] },
  { zh: ['提醒'], en: ['reminder', 'remind'] },
  { zh: ['邀请', '邀請'], en: ['invitation', 'invite'] },
  { zh: ['附件', '档案', '檔案'], en: ['attachment', 'file', 'attachments'] },
  { zh: ['下载', '下載'], en: ['download', 'downloads'] },
  { zh: ['广告', '廣告', '推销', '推銷', '促销', '促銷'], en: ['advertisement', 'promotion', 'marketing', 'spam'] },
  { zh: ['优惠', '優惠', '折扣'], en: ['discount', 'offer', 'promotion'] },
  { zh: ['退款', '退费', '退費'], en: ['refund', 'refundable'] },
  { zh: ['心理', '情绪', '情緒'], en: ['counselling', 'counseling', 'psychological', 'mental health'] },
  { zh: ['健康', '医疗', '醫療'], en: ['health', 'medical'] },
  { zh: ['疫苗', '接种', '接種'], en: ['vaccine', 'vaccination'] },
  { zh: ['校车', '校車', '班车', '班車'], en: ['shuttle', 'shuttle bus'] },
  { zh: ['食堂', '餐厅', '餐廳', '饭堂', '飯堂'], en: ['canteen', 'cafeteria', 'dining'] },
  { zh: ['打印', '复印', '複印'], en: ['printing', 'print', 'photocopy'] },
  { zh: ['网络', '網絡', '无线网', '無線網'], en: ['network', 'wifi', 'vpn', 'internet'] },
  { zh: ['密码', '密碼'], en: ['password', 'credential'] },
  { zh: ['帐号', '帳號', '账号', '賬號'], en: ['account', 'login', 'username'] },
  { zh: ['系统', '系統', '平台'], en: ['system', 'portal', 'platform'] },
  { zh: ['义工', '義工', '志愿者', '志願者'], en: ['volunteer', 'volunteering'] },
  { zh: ['交流', '交换', '交換'], en: ['exchange', 'exchange programme'] },
  { zh: ['社团', '社團', '学会', '學會'], en: ['society', 'club'] },
  { zh: ['校园', '校園'], en: ['campus'] },
  { zh: ['紧急', '緊急'], en: ['urgent', 'emergency'] },
  { zh: ['延期', '推迟', '推遲'], en: ['extension', 'postpone', 'deferral', 'reschedule'] },
  { zh: ['收据', '收據', '发票', '發票'], en: ['receipt', 'invoice'] },
  { zh: ['学号', '學號'], en: ['student id'] },
  { zh: ['时间表', '時間表', '课程表', '課程表'], en: ['timetable', 'schedule'] },
  { zh: ['学费减免', '學費減免'], en: ['remission', 'waiver'] },
  { zh: ['兼职', '兼職', '实习机会', '實習機會'], en: ['part-time', 'internship', 'job'] }
]

/**
 * 词级对照（字级表不敢收的歧义字按词处理）。
 * 例：「注册」要写成「註冊」而不是「注冊」；「回覆」的「覆」和「恢復」的「復」不同形。
 */
const WORD_VARIANTS: Array<[string, string]> = [
  ['注册', '註冊'],
  ['注销', '註銷'],
  ['注释', '註釋'],
  ['平台', '平臺'],
  ['后台', '後臺'],
  ['回复', '回覆'],
  ['答复', '答覆'],
  ['重复', '重複'],
  ['复杂', '複雜'],
  ['复制', '複製'],
  ['复印', '複印'],
  ['日历', '日曆'],
  ['历史', '歷史'],
  ['简历', '履歷'],
  ['这里', '這裡'],
  ['那里', '那裡'],
  ['心里', '心裡'],
  ['标准', '標準'],
  ['头发', '頭髮'],
  ['干活', '幹活'],
  ['面条', '麵條'],
  ['手表', '手錶'],
  ['一只', '一隻'],
  ['借口', '藉口']
]

/** 邮件语料里过于泛化的词：出现与否几乎不携带信息，检索时忽略（否则"邮件"命中一切）。 */
const GENERIC_WORDS = new Set([
  '邮件',
  '郵件',
  '邮箱',
  '郵箱',
  '收件箱',
  '信件',
  '内容',
  '內容',
  '信息',
  '相关',
  '相關',
  '有关',
  '有關',
  'mail',
  'email',
  'e-mail',
  'mails',
  'inbox',
  'mailbox',
  'message',
  'messages'
])

export function isGenericWord(token: string): boolean {
  return GENERIC_WORDS.has(String(token ?? '').trim().toLowerCase())
}

/**
 * 把泛化词从一段文本里抠掉（中文直接删词，英文按词边界删）。
 * 用于「图书馆相关的邮件」→「图书馆」这种清洗：不然检索词里混着「邮件」「相关」，打分被稀释。
 */
export function stripGenericWords(text: string): string {
  let out = String(text ?? '')
  for (const w of GENERIC_WORDS) {
    if (/^[a-z-]+$/i.test(w)) {
      out = out.replace(new RegExp(`\\b${escapeRe(w)}\\b`, 'gi'), ' ')
    } else {
      out = out.split(w).join(' ')
    }
  }
  return out
}

function escapeRe(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 英文词匹配：词边界 + 允许常见复数（\bterm(s|es)?\b）。 */
function hasEnglishTerm(text: string, term: string): boolean {
  const re = new RegExp(`\\b${escapeRe(term)}(?:s|es)?\\b`, 'i')
  return re.test(text)
}

/**
 * 从问题里识别概念，返回**另一种语言**的检索词（中文问题 → 英文写法；英文问题 → 中文写法）。
 * 同一种语言内部的同义词也会补（如「图书馆」→「圖書」），提升召回。
 */
export function bilingualTerms(text: string): string[] {
  const q = String(text ?? '')
  if (!q) return []
  const lower = q.toLowerCase()
  const out: string[] = []
  const push = (t: string): void => {
    if (t && !out.includes(t)) out.push(t)
  }
  for (const c of CONCEPTS) {
    const zhHit = c.zh.some((t) => q.includes(t))
    const enHit = c.en.some((t) => hasEnglishTerm(lower, t))
    if (!zhHit && !enHit) continue
    // 命中即把该概念的中英写法全补上（跨语言 + 同语言别名，重复由上层去重）
    for (const t of c.zh) push(t)
    for (const t of c.en) push(t)
  }
  return out
}

/** 词级简繁/异体变体：出现了 A 就补上 B（双向）。 */
export function wordLevelVariants(text: string): string[] {
  const q = String(text ?? '')
  if (!q) return []
  const out: string[] = []
  for (const [a, b] of WORD_VARIANTS) {
    if (q.includes(a) && !out.includes(b)) out.push(b)
    else if (q.includes(b) && !out.includes(a)) out.push(a)
  }
  return out
}

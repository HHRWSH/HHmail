// 打包前的产物清理：只保留当前版本的安装包，删掉历史版本的 exe/blockmap 与中间目录。
// 真机反馈：dist 里堆着 1.0.0/2.0.0 的旧安装包（那些是历史产物，不是运行必需），看着很乱。
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const product = pkg.build?.productName ?? pkg.name
const version = pkg.version
const keepPrefix = `${product} ${version}`
const keepSetupPrefix = `${product} Setup ${version}`

if (!fs.existsSync(DIST)) {
  console.log('✅ dist 不存在，无需清理')
  process.exit(0)
}

const removed = []
for (const entry of fs.readdirSync(DIST)) {
  const full = path.join(DIST, entry)
  const isCurrent = entry.startsWith(keepPrefix) || entry.startsWith(keepSetupPrefix)
  // 中间产物（解包目录 / 调试配置）每次打包都会重建，直接删
  const isIntermediate = entry === 'win-unpacked' || entry.startsWith('mac') || entry === 'builder-debug.yml' || entry === 'builder-effective-config.yaml' || entry === '.icon-ico' || entry === '.icon-set'
  const isArtifact = /\.(exe|blockmap|dmg|zip|AppImage|deb|rpm|snap)$/i.test(entry) || entry.endsWith('.exe.blockmap')
  if (isIntermediate) {
    fs.rmSync(full, { recursive: true, force: true })
    removed.push(entry)
    continue
  }
  if (isArtifact && !isCurrent) {
    fs.rmSync(full, { recursive: true, force: true })
    removed.push(entry)
  }
}
console.log(removed.length > 0 ? `🧹 已清理 ${removed.length} 项历史产物：${removed.join(', ')}` : '✅ dist 已是干净的')

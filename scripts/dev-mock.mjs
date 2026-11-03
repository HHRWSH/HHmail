// 本地 mock 模式跑真实 Electron（不碰真实账号）：npm run dev:mock
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const userData = path.join(root, '.dev-userdata')
const tmp = path.join(root, '.dev-tmp')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(tmp, { recursive: true })

const electronBin = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
if (!fs.existsSync(electronBin)) {
  console.error('❌ 找不到 Electron 可执行文件，请先 npm install')
  process.exit(1)
}
const args = ['.', '--no-sandbox', '--disable-gpu']
console.log('🚀 以 mock 模式启动 HHmail（数据目录 .dev-userdata，不碰真实邮箱）')
const child = spawn(electronBin, args, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    HHMAIL_MOCK: '1',
    HHMAIL_DISABLE_GPU: '1',
    HHMAIL_USERDATA: userData,
    TEMP: tmp,
    TMP: tmp,
    ELECTRON_ENABLE_LOGGING: '1'
  }
})
child.on('exit', (code) => process.exit(code ?? 0))

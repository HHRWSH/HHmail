// 用 Electron 的 node 模式跑评测（better-sqlite3 是 Electron ABI；并去掉 ELECTRON_RUN_AS_NODE）
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electron = require('electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const args = process.argv.slice(2)
// --dbg：跑检索调试脚本（scripts/dbg-query.ts → out/dbg-query.cjs）
const entry = args[0] === '--dbg' ? 'out/dbg-query.cjs' : 'out/eval-retrieval.cjs'
const rest = args[0] === '--dbg' ? args.slice(1) : args
const res = spawnSync(electron, [entry, ...rest], { stdio: 'inherit', env })
process.exit(res.status ?? 1)

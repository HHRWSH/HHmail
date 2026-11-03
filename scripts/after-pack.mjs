// electron-builder afterPack 钩子：
// 没有 Apple 证书时，对 macOS 产物做 **ad-hoc 签名**（codesign -s -）。
//
// 为什么必须做：Apple 芯片（arm64）上未签名的 App 会被系统直接拒绝启动
// （报"已损坏，无法打开"，连右键打开都不行）。electron-builder 在没有证书时默认只是
// 打印 "skipped macOS code signing" 就跳过，所以这里主动补一次 ad-hoc 签名；
// 等以后配了 Apple Developer 证书，脚本会自动跳过（已存在有效签名时不覆盖）。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 在 electron-builder / 系统缓存里找 rcedit（用于给 exe 换图标 + 写版本信息） */
function findRcedit() {
  const fromEnv = process.env.RCEDIT_PATH
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const roots = [
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache', 'winCodeSign'),
    path.join(os.homedir(), '.cache', 'electron-builder', 'winCodeSign')
  ]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    try {
      for (const dir of fs.readdirSync(root)) {
        for (const exe of ['rcedit-x64.exe', 'rcedit-ia32.exe', 'rcedit.exe']) {
          const candidate = path.join(root, dir, exe)
          if (fs.existsSync(candidate)) return candidate
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

/**
 * Windows：给 exe 写回品牌图标与版本信息。
 * 为什么放在这里：win.signAndEditExecutable=false 时 electron-builder 不会改 exe 元数据，
 * 装出来的应用任务栏就是 Electron 默认图标（用户反馈「图标还是图 1 那样」）。
 * 这里直接用缓存里的 rcedit 改，避免打包时联网下载 winCodeSign。
 */
function patchWindowsExe(context) {
  const appInfo = context.packager.appInfo
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  const iconPath = path.join(context.packager.projectDir, 'resources', 'icon.ico')
  if (!fs.existsSync(exePath)) {
    console.warn(`⚠ afterPack：未找到 ${exePath}，跳过图标写入`)
    return
  }
  if (!fs.existsSync(iconPath)) {
    console.warn(`⚠ afterPack：未找到 ${iconPath}，跳过图标写入`)
    return
  }
  const rcedit = findRcedit()
  if (!rcedit) {
    console.warn('⚠ afterPack：找不到 rcedit，跳过 exe 图标写入（可设置 RCEDIT_PATH 环境变量）')
    return
  }
  const version = appInfo.version ?? '0.0.0'
  const productName = appInfo.productName ?? 'HHmail'
  try {
    execFileSync(
      rcedit,
      [
        exePath,
        '--set-icon',
        iconPath,
        '--set-file-version',
        version,
        '--set-product-version',
        version,
        '--set-version-string',
        'ProductName',
        productName,
        '--set-version-string',
        'FileDescription',
        productName
      ],
      { stdio: 'inherit' }
    )
    console.log(`✅ afterPack：已写入 exe 图标与版本信息（${path.basename(exePath)}）`)
  } catch (e) {
    console.warn(`⚠ afterPack：写入 exe 图标失败：${e?.message ?? e}`)
  }
}

export default async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    patchWindowsExe(context)
    return
  }
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  if (!fs.existsSync(appPath)) {
    console.warn(`⚠ afterPack：未找到 ${appPath}，跳过 ad-hoc 签名`)
    return
  }
  // 如果已经有正式签名（配置了证书），就不要覆盖
  try {
    const info = execFileSync('codesign', ['-dv', appPath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    if (/Authority=Apple (Development|Distribution)/.test(info)) {
      console.log('✅ afterPack：检测到正式签名，跳过 ad-hoc 签名')
      return
    }
  } catch {
    /* 没有签名信息（正常：未签名）→ 继续做 ad-hoc */
  }
  try {
    console.log(`🔏 afterPack：对 ${appName}.app 做 ad-hoc 签名（无 Apple 证书时的必要步骤）`)
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
    console.log('✅ afterPack：ad-hoc 签名完成')
  } catch (e) {
    console.warn(`⚠ afterPack：ad-hoc 签名失败（产物仍会继续生成，用户首次打开需手动放行）：${e?.message ?? e}`)
  }
}

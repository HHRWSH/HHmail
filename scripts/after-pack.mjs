// electron-builder afterPack 钩子：
// 没有 Apple 证书时，对 macOS 产物做 **ad-hoc 签名**（codesign -s -）。
//
// 为什么必须做：Apple 芯片（arm64）上未签名的 App 会被系统直接拒绝启动
// （报"已损坏，无法打开"，连右键打开都不行）。electron-builder 在没有证书时默认只是
// 打印 "skipped macOS code signing" 就跳过，所以这里主动补一次 ad-hoc 签名；
// 等以后配了 Apple Developer 证书，脚本会自动跳过（已存在有效签名时不覆盖）。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export default async function afterPack(context) {
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

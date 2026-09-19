// 打包前置：准备 Electron 发行 zip 到 .electron-cache/（electronDist 指向这里）。
// 按当前平台自动选择 win32-x64 / darwin-arm64 / darwin-x64；也允许用 --platform= / --arch= 覆盖。
// 顺序：本地已有 → 复制 @electron/get 缓存 → 从 npmmirror 镜像下载（GitHub 直连慢/不通时可用）。
// 不联网也能打包（只要缓存里已有对应版本的 zip）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const electronPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "electron", "package.json"), "utf8"));
const version = electronPkg.version;

/** 目标平台/架构：默认当前机器，可用 --platform=darwin --arch=arm64 覆盖 */
function resolveTarget() {
  const argv = process.argv.slice(2);
  const readArg = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split("=")[1] : undefined;
  };
  const platform = readArg("platform") ?? process.platform; // win32 / darwin / linux
  const arch = readArg("arch") ?? process.arch;
  return { platform, arch };
}

const { platform, arch } = resolveTarget();
const zipName = `electron-v${version}-${platform}-${arch}.zip`;
const targetDir = path.join(ROOT, ".electron-cache");
const targetZip = path.join(targetDir, zipName);

if (fs.existsSync(targetZip)) {
  console.log(`✅ ${zipName} 已就绪（.electron-cache/）`);
  process.exit(0);
}

// 1) 从 @electron/get 的缓存目录找（Windows: %LOCALAPPDATA%\electron\Cache；macOS: ~/Library/Caches/electron）
const cacheRoots = [
  path.join(os.homedir(), "AppData", "Local", "electron", "Cache"),
  path.join(os.homedir(), "Library", "Caches", "electron"),
  path.join(os.homedir(), ".cache", "electron")
];
for (const cacheRoot of cacheRoots) {
  if (!fs.existsSync(cacheRoot)) continue;
  for (const dir of fs.readdirSync(cacheRoot)) {
    const candidate = path.join(cacheRoot, dir, zipName);
    if (fs.existsSync(candidate)) {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(candidate, targetZip);
      console.log(`✅ 已从本地缓存复制 ${zipName}`);
      process.exit(0);
    }
  }
}

// 2) 下载（npmmirror 优先，GitHub 兜底）
const urls = [
  `https://npmmirror.com/mirrors/electron/v${version}/${zipName}`,
  `https://github.com/electron/electron/releases/download/v${version}/${zipName}`
];
let lastErr = null;
for (const url of urls) {
  try {
    console.log(`⬇ 下载 ${url}`);
    const resp = await fetch(url, { redirect: "follow" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetZip, buf);
    console.log(`✅ 已下载 ${zipName}（${(buf.length / 1024 / 1024).toFixed(1)} MB）`);
    process.exit(0);
  } catch (e) {
    lastErr = e;
    console.warn(`⚠ 下载失败：${url} — ${e && e.message}`);
  }
}
console.error(`❌ 无法准备 ${zipName}，请检查网络后重试。`, lastErr && lastErr.message);
process.exit(1);

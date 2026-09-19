// 打包产物启动冒烟：防止「ABI 不匹配导致双击无反应」类回归。
// 用 HHMAIL_MOCK=1 启动打包产物，检查：
// 1) 无 NODE_MODULE_VERSION / unhandledRejection（原生模块 ABI 错误）；
// 2) 主进程到达 app.ready 并完成数据库迁移。
// 支持 Windows（dist/win-unpacked/*.exe）与 macOS（dist/mac*/HHmail.app）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const appName = pkg.build?.productName ?? pkg.name;

/** 找到要冒烟的可执行文件：Windows 是 exe，macOS 是 .app 内的可执行文件 */
function resolveExecutable() {
  const dist = path.join(ROOT, "dist");
  if (process.platform === "darwin") {
    const macDirs = fs.existsSync(dist) ? fs.readdirSync(dist).filter((d) => d.startsWith("mac")) : [];
    for (const d of macDirs) {
      const bin = path.join(dist, d, `${appName}.app`, "Contents", "MacOS", appName);
      if (fs.existsSync(bin)) return bin;
    }
    return path.join(dist, "mac", `${appName}.app`, "Contents", "MacOS", appName);
  }
  const dir = path.join(dist, "win-unpacked");
  const named = path.join(dir, `${appName}.exe`);
  if (fs.existsSync(named)) return named;
  const candidate = fs.existsSync(dir)
    ? fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith(".exe") && !/uninstall/i.test(f))
    : undefined;
  return candidate ? path.join(dir, candidate) : named;
}

const exe = resolveExecutable();

if (!fs.existsSync(exe)) {
  console.error(`❌ 未找到 ${path.relative(ROOT, exe)}，请先执行打包。`);
  process.exit(1);
}

console.log("🚀 打包产物启动冒烟（mock 模式，不碰真实账号）…");
const child = spawn(exe, ["--enable-logging", "--in-process-gpu", "--disable-gpu-compositing"], {
  env: {
    ...process.env,
    HHMAIL_MOCK: "1",
    // CI runner（尤其 GitHub 的 Windows/macOS 机器）没有可用 GPU：
    // 强制软件渲染，否则 Electron 会在 GPU 初始化阶段直接 FATAL（本脚本曾因此在 CI 上误报失败）
    HHMAIL_DISABLE_GPU: "1",
    // 用临时 userData：不要把冒烟测试的缓存/日志写进用户的 %APPDATA% / ~/Library
    HHMAIL_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), "hhmail-pack-"))
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", (d) => (output += String(d)));
child.stderr.on("data", (d) => (output += String(d)));

const kill = () => {
  try {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    else child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
};
const timer = setTimeout(kill, 20000);

await new Promise((resolve) => child.on("exit", resolve));
clearTimeout(timer);

if (/NODE_MODULE_VERSION|unhandledRejection/.test(output)) {
  console.error("❌ 打包产物启动异常（疑似原生模块 ABI 不匹配）：\n" + output.slice(0, 2000));
  process.exit(1);
}
if (!/app\.ready|db\.migrated/.test(output)) {
  console.error("❌ 打包产物未到达 app.ready（可能启动即崩溃）：\n" + output.slice(0, 2000));
  process.exit(1);
}
if (/GPU process isn't usable|gpu_init|Failed to create GLES3|Passthrough is not supported/i.test(output)) {
  console.warn("⚠ 日志里出现 GPU 相关警告（已强制软件渲染，不影响冒烟结论）");
}
console.log("✅ 打包产物启动冒烟通过（无 ABI 错误，app.ready 正常）");

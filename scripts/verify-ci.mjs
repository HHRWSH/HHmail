// 一次跑完「CI 在 GitHub 上会做的事」，尽量在本地提前发现问题。
//
// 用法：
//   node scripts/verify-ci.mjs            # 类型检查 + 单元测试（用 UTC 时区，和 CI runner 一致）
//   node scripts/verify-ci.mjs --with-e2e # 追加端到端（构建 + Electron 冒烟，耗时几分钟）
//
// 为什么单独写一个脚本：
// - CI runner 的时区是 UTC，本地是 Asia/Shanghai —— 测试里任何「本地时区构造时间戳 + 断言格式化后的字符串」
//   都会在 CI 上随机失败（踩过一次）。这里强制 TZ=UTC 跑单测，让本地就能复现。
// - 步骤顺序必须与 CI 一致：单测要用 Node ABI 的 better-sqlite3，E2E 要用 Electron ABI，中间必须先 build。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const withE2E = process.argv.includes("--with-e2e");

const run = (label, cmd, args, env = {}) => {
  console.log(`\n▶ ${label}\n  $ ${cmd} ${args.join(" ")}`);
  const started = Date.now();
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env }
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (res.status !== 0) {
    console.error(`\n❌ ${label} 失败（耗时 ${secs}s）`);
    process.exit(res.status ?? 1);
  }
  console.log(`✅ ${label} 通过（${secs}s）`);
};

run("类型检查", "npm", ["run", "typecheck"]);
// 单元测试：先重建 better-sqlite3 到 Node ABI，再用 UTC 时区跑（与 CI runner 一致）
run("重建原生模块（Node ABI）", "npm", ["run", "rebuild:node"]);
run("单元测试（TZ=UTC）", "npx", ["vitest", "run"], { TZ: "UTC" });

if (withE2E) {
  // tests 的 test 脚本内部会先 `npm run build` + `npm run rebuild:electron`（切回 Electron ABI）
  run("端到端自测（demo + 渲染层 + Electron）", "npm", ["run", "test:e2e"]);
}

console.log("\n🎉 verify:ci 全部通过");

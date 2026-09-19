// 真实设备码发起探测（规范 §11.9：无测试账号时验证「到 DUO 前的部分」）。
// 只请求设备码（不轮询、不登录、不落盘任何 token），打印验证链接与用户码后立即退出。
// 用法（需联网，手动执行，不属于 npm test）：node tests/e2e/devicecode-probe.mjs
const resp = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/devicecode", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: "9e5f94bc-e8a4-4e73-b8be-63364c29d753",
    scope: "https://outlook.office.com/IMAP.AccessAsUser.All",
  }).toString(),
});

if (!resp.ok) {
  console.error("❌ 设备码请求失败:", resp.status, await resp.text());
  process.exit(1);
}

const data = await resp.json();
const code = String(data.user_code ?? "");
const masked = code.length > 1 ? `${code[0]}${"•".repeat(code.length - 1)}` : "?";
console.log("✅ 设备码发起成功（未执行登录，未保存任何 token）：");
console.log("   user_code      :", masked, "（已打码，长度", code.length, "）");
console.log("   verification_uri:", data.verification_uri);
console.log("   expires_in     :", data.expires_in, "秒");
console.log("   interval       :", data.interval, "秒");
console.log("如需真实登录：启动应用 → 输入设备码（已过期则重新生成）。");

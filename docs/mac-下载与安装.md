# 在 Mac 上安装 HHmail（不需要自己有 Mac，用 GitHub 云端构建）

GitHub 提供**云端 macOS 机器**（runner）：你把代码推上去，它会自动在真 Mac 上编译打包，
产出 `.dmg` / `.zip` 给你下载。下面是完全不熟悉 GitHub 也能照做的步骤。

---

## 第 0 步：确认云端构建已经跑完

1. 浏览器打开（或者在仓库页面点顶部 **Actions** 标签）：
   **你的仓库地址 + `/actions`**（例如 `https://github.com/<你的用户名>/HHmail/actions`）
2. 列表里点最上面那一条名字叫 **build** 的记录。
3. 看它的状态标记：

   | 标记 | 含义 | 要做什么 |
   | --- | --- | --- |
   | 🟡 黄点（In progress） | 还在构建 | 等 5–15 分钟，刷新页面再看 |
   | ✅ 绿勾（Success） | 成功 | 继续第 1 步 |
   | ❌ 红叉（Failure） | 失败 | 把这一页截图发给开发者（我）来修 |

> 一条 build 里会并行跑好几个任务：`verify`（Windows 上跑测试）、`windows-x64`、`macos-arm64`、`macos-x64`。
> 只要 `macos-*` 这两个是绿勾或灰色跳过，就有 Mac 安装包可下。

## 第 1 步：下载 Mac 安装包

1. 在刚才那条 **build** 页面里，**滚到最底部**。
2. 找到 **Artifacts** 区块（一个方框，标题就是 Artifacts）。
3. 根据你的 Mac 芯片点其中一个（点下去浏览器就开始下载一个 zip）：

   - `macos-arm64` → **Apple 芯片**（M1/M2/M3/M4，2020 年之后的 Mac 基本都是这种）
   - `macos-x64` → **Intel 芯片**（2020 年之前的 Mac；CI 目前不再自动产出 Intel 包——GitHub 已退役 Intel runner，
     需要时在任意 Mac 上执行 `npm run pack:mac -- --x64` 自己打）

   不确定自己是哪种？在 Mac 上点左上角  → **关于本机**：
   - 看到「芯片：Apple M…」→ 选 `macos-arm64`
   - 看到「处理器：Intel…」→ 选 `macos-x64`

4. 下载下来的是一个 **zip**（比如 `macos-arm64.zip`）——注意：**这是 GitHub 打的一层包**，
   里面才是真正的安装文件。

> Artifacts 默认只保留 90 天；过期了只要重新跑一次构建（仓库 Actions → build → 右上「Re-run all jobs」）即可。

## 第 2 步：解压并安装

1. 在 Mac 的「下载」里双击那个 zip → 解压出一个文件夹。
2. 文件夹里会有两个文件（任选一个）：
   - **`HHmail-1.0.0-arm64.dmg`** ← 推荐：双击打开，把 **HHmail** 图标拖进「应用程序」文件夹
   - `HHmail-1.0.0-arm64.zip` ← 免安装版：双击解压得到 `HHmail.app`，直接拖进「应用程序」
3. 装好后可以在「启动台」或「应用程序」里找到 **HHmail**。

## 第 3 步：第一次打开（会被 macOS 拦一下，正常）

因为我们**没有 Apple 开发者签名**（那需要 $99/年），macOS 会提示"来自身份不明的开发者"或"已损坏"。
任选一种方式放行：

**方式 A（最简单）**
1. 在「应用程序」里 **右键点 HHmail 图标 → 打开**；
2. 弹窗里再点一次 **打开**；
3. 以后就能正常双击打开了。

**方式 B（终端命令，最彻底）**
打开「终端」，粘贴这一行回车（会让你输入 Mac 登录密码）：
```bash
sudo xattr -dr com.apple.quarantine "/Applications/HHmail.app"
```

**方式 C**
打开「系统设置 → 隐私与安全性」，在下面会看到"已阻止 HHmail"，点 **仍要打开**。

## 第 4 步：登录

1. 打开 HHmail → 点「开始登录」→ 会打开浏览器让你用**学校微软账号**登录；
2. 登录完回到 HHmail，它会自动开始同步（首次同步比较慢，之后都是增量）；
3. 收件箱、AI 摘要、AI 问答、标签与类别都在本机运行。

> 注意：**登录状态与数据是本机独立的**，Mac 上需要重新登录一次。
> Windows 上的邮件库不会同步到 Mac（数据是本地优先设计的）。

---

## 常见问题

**Q：为什么下载的是 zip 不是 dmg？**
A：GitHub 的 Artifacts 总会再打一层 zip（方便批量下载）；解压后里面才是 dmg/zip。

**Q：能不能做成"双击即开、没有警告"的版本？**
A：可以，但需要 Apple Developer 账号（$99/年）。配好签名证书与公证（notarization）后就没有任何提示了；
把证书放到仓库的 Secrets 里即可自动完成（见 README「持续集成 / macOS 版本」）。

**Q：我能在自己的 Mac 上直接打包吗？**
A：可以。装好 Node 20+ 与 Xcode 命令行工具后：
```bash
npm ci
npm run pack:mac        # 产出 dist/HHmail-1.0.0-<arch>.dmg / .zip
```

**Q：构建失败怎么办？**
A：把 Actions 里那条失败任务的日志（或整页截图）发给开发者即可，常见原因：
`macos-13` runner 下线（Intel 包）、原生模块 `better-sqlite3` 编译、图标尺寸、dmg 制作权限。

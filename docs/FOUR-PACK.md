# 四端同源打包方案（four-pack）

一次 `npm run pack:all`，得到 Linux、Windows、Mac、Android 四个安装产物。
四个包里是**同一份界面目录、同一套接线逻辑**；聊天、设置、Connect 只改仓库
一处，四个包一起带上。本文是可以照着做的步骤清单和三个守门检查；实现状态
用 ✅（已落地）/ ⬜（待做）标注。

---

## 0. 一句话架构

```text
同一份界面目录（pinned renderer + Windows overlay + client-overrides，四包同哈希）
        │
        │  window.desktop + window.coordinatorPort   ← 同一份客户端接线契约
        ▼
┌─ 电脑：Electron preload → main/coordinator（Node 网络直连盒子）
└─ 手机：网页运行时（编进页面的同一套 TS） → 127.0.0.1 本机转发器（Kotlin）
          → 转发器去掉 Origin、加上令牌 → 盒子 /api、/events、/avatars、/health
盒子：host + 网关（带 Origin 的请求一律 403，见 source/host/gateway-server.ts:23）
```

手机多出来的只有「出门要经过本机转发器」这一件事；聊天逻辑、listAgents、
发消息一律不进 Java，全部走 `source/` 里那一份 TypeScript。

## 1. 这份仓库已经有什么（方案的地基）

| 部件 | 位置 | 状态 |
| --- | --- | --- |
| 界面唯一来源（钉死的官方 renderer + `client-ui/renderer-overlay/` 的 Windows Router 页） | `src/app/dist/renderer` 再盖 overlay；`npm run bootstrap` 校验钉死层 | ✅ |
| 三个 Electron 包打包路径（同一 `package-electron.mjs`，同一 asar） | `scripts/package-{macos,windows,linux}.mjs` → `packageElectronDesktop` → `buildFidelityReconstructedAsar` | ✅ |
| 客户端接线契约（`window.desktop` / `window.coordinatorPort`，渲染端启动即校验） | `source/electron-preload/preload.ts`、`source/client-runtime/*`、`frontend/src/production/bootstrap.tsx` | ✅ |
| 协调器（盒子的 HTTP+SSE 客户端、渲染端口协议、事件分发） | `source/node-agent-coordinator/*`（gateway-client、renderer-port-server） | ✅ |
| 盒子侧「带网页来源（Origin）一律 403」 | `source/host/gateway-server.ts:23` `rejectUntrustedBrowserRequest` | ✅ |
| 密钥库（Android Keystore，AES/GCM） | `targets/android/.../SecretsStore.java` | ✅ |
| Android 打包路径 | `scripts/package-android.mjs` | ✅ 已改为吃同一份界面目录（本文步骤 2） |
| 本机转发器 + WebView 壳改造 + 网页运行时 | `targets/android/.../GatewayForwarder`、`source/client-runtime/web/` | ⬜ 步骤 3–6 |

## 2. 步骤（按顺序做，每步有验收）

### 步骤 1：一份界面目录 ✅

**做什么**：`scripts/build-client-ui.mjs`（npm run pack:ui）产出
`.build/client-ui/ui/`：

- `renderer/` —— `src/app/dist/renderer` 的拷贝，再盖 `client-ui/renderer-overlay/`（Windows 当前设置页/聊天页，含 Router API）；
- `client-overrides/` —— 我们附加的、对所有平台无害的界面旁挂文件
  （`mobile.css` 等，桌面不引用不加载）；
- `client-ui-manifest.json` —— 逐文件 `bytes` + `sha256` 清单。

四个包只**拷贝**这份目录，永不各自构建。禁止改 `src/app/dist`（bootstrap
校验会拦）；禁止给 Android 单独跑 `frontend/vite.config.ts`（那是 dev/recovered
外壳，哈希必然分叉）。

**验收**：连续两次构建 manifest 完全一致；`renderer/` 清单与
`createRendererArtifactProvenance` 的钉死清单同源。

### 步骤 2：Android 打包改吃同一目录 ✅

`scripts/package-android.mjs` 重写为：

1. 调 `buildClientUi()` 拿同一份目录；
2. `ui/renderer/*` → `targets/android/www/` 与
   `app/src/main/assets/www/`；`ui/client-overrides` 原样带上；
3. 拷贝后逐文件对照 manifest 校验哈希（不一致即失败）；
4. `gradle assembleRelease` 出可侧载 APK（非 Android Debug 证书、非 debuggable）。

Electron 侧（三个桌面包）走同一套 `scripts/lib/package-electron.mjs`：
`buildFidelityReconstructedAsar` 把 `buildClientUi()` 的 renderer（钉死层 +
Windows overlay）和 `client-overrides` 打进 asar。覆盖的两个 chunk 写入
`dist/renderer-router-extension.json`，macOS 的 checksum-pinned 校验认这份扩展，
不另做 Linux 特供包。

**验收**：`tests/four-pack.test.mjs` 锁死——android 打包脚本不得再引用
vite dev 配置 / desktop-shell / recover-frontend。

### 步骤 3：本机转发器（Kotlin，只转发） ✅

`targets/android/app/src/main/java/com/grokbot/reconstructed/ForwarderCore.java`
（纯 JVM，可在桌面 JDK 上测试）+ `GatewayForwarder.java`（Android 胶水）：

- 在 `127.0.0.1:17537`（被占则向后找 20 个）监听，固定端口保证
  localStorage 按来源持久；
- **静态文件**：`/` 与界面资源从 assets（www）读出；index.html 在
  `<head>` 后注入 `<script type="module" src="/client-overrides/boot.js">`，
  保证网页运行时先于界面 bundle 执行；
- **代理**：`/api/*`、`/events`、`/avatars/*`、`/health` →
  `HttpURLConnection` 转到 Connect 里填的盒子地址；
  - 删除 Origin、Referer、Sec-Fetch-*（`STRIPPED_HEADERS`）；
  - 加 `Authorization: Bearer <令牌>`（Keystore，`SecretsStore`）；
  - 所有上游请求 `Accept-Encoding: identity`；响应一律 8KB 分块泵转发，
    **没有任何整段缓冲**（SSE 不会憋死）；
  - 其余路径 404；循环回环的盒子地址直接 502 + 人话提示。

**验收**：`tests/java/ForwarderCoreTest.java`（真实 socket + mock 盒子，
JDK 下 `node --test` 自动编译运行）六项全过：头剥离、令牌注入、请求体
透传、SSE 首块 <300ms、boot 注入、loopback 拒绝。

### 步骤 4：WebView 壳改造 ✅

`MainActivity.java`：

1. 启动 `GatewayForwarder`，`loadUrl("http://127.0.0.1:<port>/")`，
   `setAllowFileAccess(false)`；
2. `WebViewCompat.addDocumentStartJavaScript` 再注入一次 boot import
   （双保险，老 WebView 走转发器注入那条路）；
3. `SandNative` 扩展：盒子地址 prefs 读写、`getForwarderPort`、
   `hasGatewayToken()`（只报有无，永不返回令牌）、`probeGateway`
   （原生探测 /events，带桌面同款人话文案——网页直连探测会被 Origin 403）；
4. manifest：`windowSoftInputMode="adjustResize"`；`usesCleartextTraffic`
   允许 http:// 局域网盒子。

### 步骤 5：网页运行时（同一份接线，编进页面） ✅

`source/client-runtime/web/`（esbuild 打包为
`client-overrides/boot.js`，四个包同哈希携带，只有 Android 执行）：

- `window.coordinatorPort`：`CoordinatorGatewayClient` +
  `createGatewayRequestDispatch` + `createRendererPortServer` +
  `ClientSideToolV2Relay` —— 和桌面协调器同一份 TS，只把连接基地址换成
  `location.origin`（转发器）、令牌置空（原生层加）；
- `window.desktop`：`createDesktopBridge`（原样）+ 页内 main 通道：
  **直接复用 `source/electron-main/main-edge.ts` 的
  `createMainEdgeHandlers`**，桌面后端换成 web 后端（stores.ts 的
  localStorage 版 settings/agentPrefs/boxToggle/onboarding/theme）；
  secrets、clientPersistence 走与桌面专用通道同语义的 fallback
  （SandNative / localStorage）；
- Connect：`parseSelfHostGatewayAddress` 拒 127.0.0.1/localhost（与桌面
  共用同一模块），令牌只进 Keystore，探测走原生；
- 附件：图片 `readAttachmentImage` → dataUrl；上传用内存 staging +
  `uploadAttachment`；`readAttachmentChunk` 分块下载；
- `node:crypto`/`shared/node/*`/`local-docker-host-connector` 经 esbuild
  shim 替换（见 shims/）；`shared/outbound-proxy.ts` 的 node 导入改为
  用到时动态加载（桌面行为不变）。

**v1 已知边界**（都不是第二套协议，是能力边界）：

- 手机上账号态为中性 `logged-out`（登录动作指向桌面端）；
- Router 建议保持在 Cursor/OpenRouter：Claude Code/Codex 的路由发生在
  桌面协调器（本地 CLI 会话），手机没有；
- 视频/音频附件与链接预览降级为占位（渲染端有对应空态）。

**验收**：`tests/web-runtime.test.mjs`（真实打包 + Node 运行）——main
通道主题/引导/密钥/Connect 语义、协调器 hello→ready、listAgents 经
`/api` 到 mock 盒子、**页面发出的请求永远没有 Authorization 头**、
SSE 带 identity 编码。

### 步骤 6：窄屏收侧栏（不重写界面） ⬜ 基础已落地

`source/client-overrides/mobile.css`（四包同带，boot.js 在 Android 上注入并
设 `data-sand-mobile`）：安全区、字号、overscroll 基础规则已落地；侧栏
收起断点需要在真机上对照渲染器实际 DOM 测一次后补进这一个文件。宽屏不带
`data-sand-mobile`，样式不生效。

### 步骤 7：打包入口 ✅

`npm run pack:all`（`scripts/package-all.mjs`）：

1. `npm run check`（可用 `GROK_BOT_PACK_SKIP_CHECK=1` 跳过）；
2. `buildClientUi()` 构建一次界面目录；
3. 依次打包：`linux-x64`、`windows-x64`、`android`（+ darwin 上
   `macos-arm64`；可用 `GROK_BOT_PACK_TARGETS=android` 选子集）；
4. 对本次构建的目标跑 `scripts/verify-four-pack.mjs`，FAIL/NOT-READY 即整体
   退出非 0（不许当同步完成）。

产物：`dist/openbot-linux-x64/` 与 `dist/openbot-linux-x64.zip`、
`dist/openbot-win32-x64/` 与 `dist/openbot-win32-x64.zip`、
`dist/openbot-android.apk`（Gradle 原件仍在
`targets/android/app/build/outputs/apk/release/app-release.apk`）、
`dist/Grok Bot 0.18 Reconstructed.app`（darwin）。

### 步骤 8：盒子侧部署提醒（一次性）

盒子必须听局域网网卡：self-host 配方已用 `SAND_GATEWAY_BIND_HOST=0.0.0.0`
（`source/shared/self-host-box.ts`、`docs/self-host.md`）。只绑 127.0.0.1 的
盒子手机永远进不去——这是部署问题，不是客户端逻辑。

---

## 3. 三个检查（verify-four-pack，不通过不许算同步完成）

`scripts/verify-four-pack.mjs`，退出码：0 通过 / 1 FAIL / 2 NOT-READY（缺某
一步的实现）。规则函数在 `scripts/lib/four-pack.mjs`，
`tests/four-pack.test.mjs` 随 `npm test` 常驻。

### 检查一：四个包是不是同一份界面

- 对每个产物取界面清单并逐文件比对 `client-ui-manifest.json`：
  - Electron 三包：`resources/app.asar` 内 `dist/renderer/**` +
    `dist/client-overrides/**`（`@electron/asar` 提取）；
  - Android：APK 内 `assets/www/**`（或 staging 目录 `www/`）；
- Android 侧额外断言：无 `*.map`、无 `desktop-shell.js`、无
  `__reconstructed_health`（recovered/dev 前端痕迹）；
- 任何文件哈希不一致 → FAIL（这就是「Linux 打包把设置补丁丢了」「Android
  又打 recovered 前端」的闸门）。

### 检查二：手机是不是绝不直连盒子

- **实测盒子规则**：把 `source/host/gateway-server.ts` 真的跑起来（本机
  127.0.0.1），带 `Origin` 的请求必须 403；不带 Origin、带令牌必须 200
  （`tests/four-pack.test.mjs` 常驻）；
- **转发器静态规则**（文件存在即启用）：必须删除 Origin/Referer/Sec-Fetch-*，
  必须从 SecretsStore 取令牌，`/events` 必须流式（禁止整段读入：
  不出现 `ByteArrayOutputStream`，必须有缓冲泵循环），`/events` 请求必须带
  `accept-encoding: identity`；违反 → FAIL；
- **网页运行时静态规则**（文件存在即启用）：不允许出现绝对盒子地址字面量、
  不允许向 SandNative 索要网关令牌、网关调用基地址必须是
  `location.origin`；违反 → FAIL；
- 对应文件还不存在 → NOT-READY（指到步骤 3/5），不许假装通过。

### 检查三：看起来能用、其实会坏的细节

| 坑 | 闸门 |
| --- | --- |
| 手机把 127.0.0.1 填成盒子地址 | `source/shared/self-host-address.ts` 单测：loopback 一律拒 + 人话提示；网页运行时落进 Connect 页（步骤 5 静态规则验证接线） |
| `sand-media:` 图片裂 | manifest 锁死 index.html（CSP 含 sand-media:）；网页运行时 `resolveAttachmentMedia` 必须产同源 URL（步骤 5 静态规则） |
| 令牌进网页被脚本读走 | 检查二静态规则：运行时无令牌通道；转发器持有令牌 |
| SSE 被一次性读进内存 | 检查二静态规则：流式泵、identity 编码 |
| `file://` 加载 + 打外网 | 检查二/三：MainActivity 必须 `http://127.0.0.1:<port>/` 且 `setAllowFileAccess(false)` |
| 盒子只绑 127.0.0.1 | 步骤 8 文档 + self-host 配方测试（`tests/self-host-box.test.mjs` 已锁 0.0.0.0） |
| 四包界面哈希分叉 / recovered 前端回流 | 检查一 + `tests/isomorphism.test.mjs` 的打包器源码锁 |

## 4. 分叉守则（禁止事项）

- 禁止改 `src/app/dist`；禁止四个包各自构建界面；
- 禁止 Android 打 `frontend/vite.config.ts` dev 外壳或任何 recovered 组合；
- 禁止在 Java 里写 listAgents/发消息/第二套 API；
- 禁止网页拿令牌、网页直连盒子；
- 禁止把转发器写成「会懂聊天」的代理（它只认路径和头）；
- 禁止绕过 `verify-four-pack` 发布任何一端。

## 5. 日常操作

```sh
npm ci && npm run bootstrap     # 首次
npm run pack:all                # 一次出四包（含三个检查）
npm run verify:four-pack        # 只跑检查
npm run pack:ui                 # 只重建界面目录
GROK_BOT_PACK_TARGETS=android npm run pack:all   # 只打安卓
```

任何界面/接线/设置的改动落在 `source/`、`frontend/`、`client-overrides/`，
然后 `npm run pack:all` —— 改一处，四包同源带出。

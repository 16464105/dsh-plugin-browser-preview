# dsh-plugin-browser-preview

在 DSH Web 页面里悬浮一个可拖拽窗口，实时显示 **Agent 正在操作的那个浏览器**。

Agent 走 CDP 控制浏览器，预览窗口抓同一个实例的画面 —— 不是第二个浏览器，也不是录屏。

## 与最初设计文档的差异

文档里的写法（`dsh.bundle.json`、`@cordisjs/core` v3 的 `Schema`、`ctx.router`、`client.ts` 裸 DOM 注入）对应的是旧版 Cordis 插件体系，DSH `0.1.7-alpha.2` 上都不存在。本插件按现在的真实契约实现：

| 文档写法 | 0.1.7-alpha.2 实际契约 |
| --- | --- |
| `dsh.bundle.json` 清单 | `package.json` 的 `dsh.bundle.patch` + `dsh.client.platform`，没有独立清单文件 |
| `@cordisjs/core` 的 `Schema` | `@deepseek-ai/schemastery`（`z.object` / `z.string().default()`），放进 `peerDependencies` |
| `ctx.router.mount/get` | `ctx.webServer.register`（`kind: 'exact' \| 'prefix'`）与 `registerUpgrade`（**精确路径**，无前缀语义） |
| `client.ts` 注入 `<script>`/DOM | `src/client/index.tsx` + `ctx.slots.register`，产物是 `window.__ModuleLoader__.load({ id, factory })` 包装的 CJS |
| `ctx.on('dispose')` 杀进程 | `ctx.effect(() => cleanup)` |
| `dsh plugin add ./` | `dsh plugin --profile <p> add /绝对路径`（相对路径会被拒） |

另外文档的 noVNC 通道保留为可选（`previewMode: 'vnc'`），默认通道换成了 CDP 抓帧，原因见「实测坑」。

## 安装前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| DSH | `>=0.1.7 <0.2.0`，**web profile** | 清单里声明了 `dsh.compatibility`，其它版本未测；headless profile 能用 CDP 但没有预览窗口 |
| Node | `>=22`（MCP server 侧要求 `^22.19 \|\| >=24`） | 插件 host 用了全局 `WebSocket`；宿主本身也是这个要求 |
| 浏览器 | Chromium / Google Chrome | 默认 `chromiumBin: auto`，依次探测 `chromium` → `chromium-browser` → `google-chrome` → `google-chrome-stable` |
| 中文字体 | 任意 CJK 字体 | 缺了页面里的汉字会全变成方块（见排查第 8 条） |
| 构建 | `npm`（装 esbuild/typescript）、`git`（可选，用于生成构建号） | 产物是 `lib/`，远端 clone 后必须 `npm install && node build.mjs` |
| 端口 | `9222`（CDP）默认空闲 | `vnc` 模式另需 `5900`/`6080` |
| 网络 | 能装 npm 依赖（`mcp/` 需要 `@modelcontextprotocol/sdk`） | 离线机器请在同目录预装好 `node_modules` |

**默认（screencast）模式**只需要浏览器 + 字体；**Xvfb/x11vnc/novnc/websockify** 仅在 `previewMode: 'vnc'` 时才需要。

各发行版包名：

```bash
# TencentOS / RHEL / CentOS（实测版本）
dnf install -y google-noto-sans-cjk-ttc-fonts && fc-cache -f
dnf install -y https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm
# 仅 vnc 模式：
dnf install -y xorg-x11-server-Xvfb x11vnc novnc python3-websockify

# Debian / Ubuntu
apt install -y fonts-noto-cjk chromium   # 或 google-chrome-stable
# 仅 vnc 模式：
apt install -y xvfb x11vnc novnc websockify
```

装完自检（应看到 `ready: true` 和页面标题）：

```bash
curl -s http://127.0.0.1:3080/browser-preview/api/status | head -c 400
```

### 依赖检测与（可选）自动安装

插件启动时会检测浏览器、中文字体（vnc 模式还会检测 Xvfb / x11vnc / novnc / websockify），缺失项会显示在预览窗口里，也可以查：

```bash
curl -s http://127.0.0.1:3080/browser-preview/api/deps
# {"platform":"tencentos/rhel/fedora","manager":"dnf","root":true,"missing":[],"deps":[]}
```

**安装系统包默认是关的**（这类操作涉及 root 与网络，不该偷偷做），三种显式触发方式：

1. 预览窗口里点「一键安装（dnf/apt）」
2. 调接口：`curl -X POST http://127.0.0.1:3080/browser-preview/api/deps -d '{}'`（`{"deps":["chromium"]}` 可只装某一项）
3. 配置 `autoInstall: 'on-start'`，插件启动时自动补齐

约束：包名按发行版白名单（dnf / apt），命令以 argv 数组执行（不经 shell），root 直接装、非 root 走 `sudo -n`（需免密 sudo），每条命令有超时，失败原因写进返回值的 `log`；中文字体装完会执行 `fc-cache -f`。Chromium 在 TencentOS 仓库里没有，会自动回退到 Google 的 RPM。

## 安装

```bash
cd /data/workspace/dsh-plugin-browser-preview
npm install --ignore-scripts   # esbuild + typescript
node build.mjs                 # 产出 lib/index.js（host）与 lib/client.js（client）

dsh plugin --profile web add /data/workspace/dsh-plugin-browser-preview
# 重启 DSH Web 服务
```

`dsh plugin add` 会把包名写进 profile 的 `dsh.profile.bundles`；本地目录装成 `link:`，改完代码 `node build.mjs` + 重启即可生效，不用重新 add。

系统依赖（TencentOS/RHEL）：

```bash
dnf install -y xorg-x11-server-Xvfb x11vnc novnc python3-websockify
dnf install -y https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm
# 中文字体：缺了页面里的汉字会全变成方块
dnf install -y google-noto-sans-cjk-ttc-fonts && fc-cache -f
```

Debian/Ubuntu：`apt install -y xvfb chromium x11vnc novnc websockify fonts-noto-cjk`。

## 配置

在「设置 → 插件 → Browser Preview」里改（Config schema 由宿主自动投影成表单）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `headless` | `true` | 有头模式在本机不开放 CDP 端口，默认无头 |
| `previewMode` | `screencast` | `screencast` = CDP 抓帧；`vnc` = noVNC + websockify |
| `vnc` | `false` | 是否拉起 Xvfb + x11vnc + websockify 栈 |
| `screencastFps` | `2` | 抓帧频率（每秒），去重后推送 |
| `screencastQuality` | `70` | JPEG 质量 |
| `chromiumBin` | `auto` | `auto` 依次探测 chromium/chromium-browser/google-chrome/google-chrome-stable |
| `cdpPort` / `vncPort` / `novncPort` | `9222` / `5900` / `6080` | 端口 |
| `xvfbDisplay` / `screenWidth` / `screenHeight` | `:99` / `1600` / `900` | VNC 模式用 |
| `userDataDir` | `/tmp/dsh-agent-chrome` | 浏览器 profile 目录 |
| `startTimeoutMs` | `20000` | 单步启动超时 |
| `autoStart` | `true` | 插件加载即拉起浏览器栈 |
| `autoInstall` | `off` | `on-start` = 启动时自动安装缺失的系统包（需 root 或免密 sudo）；`off` = 只报告不动手 |
| `installTimeoutMs` | `600000` | 单条安装命令的超时 |
| `keepBrowser` | `true` | 插件重载/DSH 重启时**保留**正在运行的 Chromium（标签和 Agent 手里的 `targetId` 才不会失效），下次启动自动复用；设为 `false` 则一起回收 |
| `verbose` | `false` | 子进程输出全量转发到宿主日志 |

## HTTP / WebSocket 接口（同源，都在 `/browser-preview` 下）

| 路径 | 说明 |
| --- | --- |
| `GET /browser-preview/api/status` | 状态 + 诊断（进程、缺失二进制、抓帧计数、最后错误） |
| `WS /browser-preview/stream` | 二进制 JPEG 帧下行；上行文本 JSON 回传鼠标/滚轮/键盘 |
| `GET /browser-preview/api/deps` | 依赖探测：发行版、包管理器、是否 root、缺少哪些、将要安装哪些 |
| `POST /browser-preview/api/deps` | 按 `{"deps":[...]}` 安装依赖（省略则装所有缺失项），返回安装结果 |
| `GET /browser-preview/api/target` | 当前所有页面 + 固定的目标 |
| `POST /browser-preview/api/target` | 按页面固定（`{id}`）、按会话切换（`{session}`）或恢复跟随最新（`{id: null}`） |
| `GET /browser-preview/view` | 独立全屏预览页（悬浮窗 ↗ 打开；screencast 模式自带查看器，`vnc` 模式 302 到 noVNC） |
| `WS /browser-preview/ws` | noVNC 到 websockify 的 WebSocket 桥（仅 `vnc` 模式） |
| `/browser-preview/*` | noVNC 静态资源反代（仅 `vnc` 模式） |

输入回传格式（坐标是 0..1 的图片相对值，服务端按视口尺寸换算）：

```json
{"t":"mouse","type":"mousePressed","button":"left","buttons":1,"clickCount":1,"x":0.5,"y":0.4}
{"t":"wheel","x":0.5,"y":0.4,"deltaX":0,"deltaY":-120}
{"t":"text","text":"hello"}
```

Agent 侧直接连 `ws://127.0.0.1:9222/devtools/browser/<id>`（或 `/json/list` 里的页面地址）。

## 给 Agent 的浏览器工具（MCP）

没有工具，Agent 只会说"我没有浏览器能力"然后退回 HTTP 抓取。配套 `mcp/` 目录是一个独立 MCP server（stdio，底层就是这个浏览器实例的 CDP），注册后 Agent 直接多出一组浏览器工具：

| 工具（前缀 `mcp__browser__`） | 作用 |
| --- | --- |
| `status` | 当前页面 URL / 标题 / CDP 端口 |
| `open(url)` | **新开一个标签页**打开（不复用现有页面），返回 `targetId` |
| `screenshot()` | 截当前页面，返回 JPEG 图片块 |
| `text(limit)` | 读正文 innerText |
| `click(selector \| x,y)` | 点击元素 |
| `type(text, selector?, pressEnter?)` | 输入文本 |
| `scroll(dy)` | 滚动 |
| `back()` | 后退 |
| `eval(expression)` | 执行 JS（调试用） |

**多个会话共用一个浏览器**：`open` 每次都新建标签页并返回 `targetId`，其余工具都支持可选的 `targetId` 参数（不传则作用于最新页面），所以两个会话不会互相导航对方的页面。

**预览按会话绑定**（默认行为）：

1. 插件在 host 端订阅 `tools/result`，从 `mcp__browser__open` 的返回值里取出 `targetId`，结合 `exec.agent.session.id`，维护一张「会话 → 标签」映射；那个页面会立刻显示在预览窗口里。
2. client 端订阅 `ctx.uiSession.adapter.current`（当前会话）与 `ctx.sessions.list`（会话标题）。`shell.overlay` 是 root scope，拿不到 slot 的 `sessionId` prop，所以走这两个服务而不是 props。
3. 你在左侧**切换会话**时，预览窗口自动切到该会话打开的页面；该会话还没开过页面则保持跟随最新页面。
4. 标签栏是**会话列表**（显示会话名，当前会话带 `●`）；`跟随会话` 开关默认开启，关掉就完全手动点选。会话对应的标签被关掉时映射自动清除（新建 10 秒内的绑定除外，避免标签还没出现在列表里就被误删）。
5. 当前会话**没打开过页面**时显示空白占位，而不是沿用上一个会话的画面。
6. 绑定只存在内存里：DSH 重启后 Agent 下次调用任意浏览器工具（带 `open` 返回的 `targetId`）就会自动重建。`keepBrowser: true` 保证重启不会连浏览器一起销毁，所以那些 `targetId` 依然有效。

注册步骤：

```bash
cd mcp && npm install
```

然后在 **设置 → MCP → ＋ 添加 MCP 服务器 → stdio**：名称 `browser`（决定 `mcp__browser__*` 前缀）、命令 `node`、参数 `/data/workspace/dsh-plugin-browser-preview/mcp/src/index.js`、工作目录同上。保存即连接，状态徽章显示「已连接 (9 个工具)」。

等价的 API 方式（脚本化部署用）：

```bash
curl -X POST http://127.0.0.1:3080/mcp-manager/api/servers -H 'content-type: application/json' \
  -d '{"name":"browser","type":"stdio","command":"node",
       "args":["/data/workspace/dsh-plugin-browser-preview/mcp/src/index.js"],
       "cwd":"/data/workspace/dsh-plugin-browser-preview/mcp"}'
```

注意点：

- 工具**不需要新开会话**：Agent 每一步请求前都会重新组装工具表（`ctx.tools` 注册表 → `systemPrompt.assemble()`），注册完成后下一条消息就能用，已存在的会话也一样。子 Agent 若带 `allow` 白名单则可能被过滤。
- CDP 端口用 `DSH_BROWSER_CDP_PORT` 覆盖（默认 `9222`），必须和插件的 `cdpPort` 一致。
- `screenshot` 返回的是 MCP 图片块：DSH 会按模型能力转成 attachment 或降级成文本占位符。
- 若开启了 MCP 管理器的「按需模式」，Agent 只看到 `mcp_search_tools` / `mcp_describe_tool` / `mcp_execute_tool`，用它们间接调用即可。

## 实现要点

- **进程托管**：Xvfb → Chromium → x11vnc → websockify 顺序拉起，每一步都先探测端口/socket，已存在则复用（不抢别人的实例）；所有子进程 `detached` 成组，退出时按逆序 `SIGTERM` → 3s → `SIGKILL` 整组回收，`ctx.effect` 保证 dispose 时清理。
- **抓帧**：`Page.captureScreenshot` 定时抓、逐帧比对去重，只推有变化的帧；新观众连接时立刻补发当前帧。连续 3 次超时判定渲染器卡死，断开重连并重新选页。
- **选页**：每 4s 读 `/json/list`。固定了目标就用固定目标；没固定则优先非 `about:blank` 的最后一个页面（Agent 新开的标签页自动成为预览对象）。固定的标签被关闭时自动回退到跟随。
- **反向代理**：noVNC 的 HTTP 走 `node:http` 转发（剥掉 hop-by-hop 与 `accept-encoding`，避免与宿主的 gzip 中间件叠加）；WebSocket 走裸 socket 转发，握手交给 websockify。
- **自实现 WS 服务端**：`registerUpgrade` 交来的是原始 socket，所以 `src/ws.ts` 里做了 101 握手与帧编解码（含 ping/pong）。

## 实测坑

1. **有头 Chromium 不开放 CDP 端口**。Chrome 155/156 在这台机器的 Xvfb 下，无论 `--remote-debugging-port` 还是 `--remote-debugging-address`，DevTools HTTP 端点都不监听（headless 正常）。所以默认走无头 + CDP 抓帧，`vnc` 模式只是"能看画面但 Agent 连不上"的降级通道。
2. **`Page.startScreencast` 在无头下不可靠**。同一页面上它只推 1 帧，`captureScreenshot` 却能反复拿到新帧，因此抓帧走 capture。
3. **`data:` URL 顶层导航会被拒**。用 `Page.navigate` 打开 `data:text/html,...` 会静默失败，页面仍是 `about:blank` —— 排查时会误判成"渲染器停摆"。要注入测试内容请用 `Runtime.evaluate` 或真实 HTTP 页面。
4. **卡死的页面会拖垮帧流**。残留的坏页面被选为目标后 `captureScreenshot` 一路超时，此时状态接口的 `stream.lastError` 会显示 `captureScreenshot timeout`，连续 3 次后插件自动换页。
5. **`registerUpgrade` 是精确路径**：noVNC 的 WS 路径必须固定（`vnc.html?path=/browser-preview/ws`），不能用前缀。
6. **`/api`、`/plugins` 前缀被宿主占用**，插件路由不要碰。
7. **`fetch` 在本进程内不可靠**：宿主可能装了全局 undici dispatcher（出向代理），读 CDP 的 `/json/list` 用 `node:http` 直连。
8. **汉字显示成方块不是编码问题，是缺字体**。页面 UTF-8 解码正常、`innerText` 也正常，但 X11 下没有中文字形可用就只能画豆腐块。`fc-list :lang=zh` 为空即确诊，装 `google-noto-sans-cjk-ttc-fonts` + `fc-cache -f` 后**必须重启浏览器进程**（Chromium 在启动时读取字体表，热刷新无效）。
9. **拖拽会吞掉按钮点击**。在 header 的 `onPointerDown` 里 `setPointerCapture`，会把按钮的 mousedown/mouseup 重定向到 header，按钮的 `onClick` 永远不触发（现象：三个按钮"完全没反应"，但拖动正常）。修法是 pointerdown 阶段就排除 `button, a`，并让按钮自身 `stopPropagation`。
10. **两个内联 HTML/字符串的坑**：`renderViewerHtml` 用模板字符串拼 HTML，注释里出现反引号会提前闭合字符串（构建期就报错）；查看页脚本里的变量不能叫 `status` —— 它是内置的 `window.status`（字符串属性），赋值不会落到 DOM 元素上，状态文案会一直停在初始值。

## 目录

```
dsh-plugin-browser-preview/
├── package.json          # dsh.bundle.patch / dsh.client.platform / peerDeps
├── cordis.patch.yml      # insert 一个 browser-preview 实例
├── build.mjs             # esbuild：host ESM + client CJS(__ModuleLoader__ 包装)
├── src/
│   ├── index.ts          # 入口：路由注册、生命周期
│   ├── config.ts         # Config schema
│   ├── stack.ts          # 子进程栈托管
│   ├── cdp.ts            # CDP 抓帧 + 输入回传
│   ├── proxy.ts          # noVNC HTTP/WS 反代
│   ├── ws.ts             # 极简 WebSocket 服务端
│   ├── shared.ts         # 两端共享的路径常量与状态类型
│   └── client/index.tsx  # shell.overlay 悬浮窗
└── lib/                  # 构建产物（勿手改）
```

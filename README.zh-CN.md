# Alma Android

[Alma](https://alma.now) 远程访问的 Android 客户端，用于在手机上操作
[Herdr](https://herdr.dev) 里运行的 coding agent。

配对一台或多台 Alma 桌面后，可以在手机上使用 Claude Code、Codex、pi。
模型、agent 进程和 API Key 都留在桌面端，手机只是一扇窗。

[Alma](https://alma.now) 是 **yetone** 打造的桌面 AI 工作区：一个应用接入所有模型，
可以翻阅并编辑的记忆，Skills 与 MCP，以及本客户端依赖的——扫码即可建立的加密远程访问。
[Herdr](https://herdr.dev) 则是面向 coding agent 的终端工作区管理器，让 Claude Code、
Codex、pi 继续跑在各自终端里，同时让侧栏和手机都能看到它们在做什么。

> English: [README.md](README.md)

## 致谢

- **[yetone](https://github.com/yetone)**：[Alma](https://alma.now) 的作者，本客户端连接的中继来自 Alma。
- **[nanami-0713](https://github.com/nanami-0713/alma-android)**：本项目起步所用的 Capacitor 壳。
- **[lazyeo](https://github.com/lazyeo/alma-android)**：中继握手的一份清晰参考实现。

## 能做什么

**多节点。** 每次配对是一台独立桌面，各自使用自己的中继和凭据。客户端为每台维持一条
加密隧道；不同机器上的同名 pane 不会串内容，也不会串发送目标。下次启动会回到上次使用的桌面。

**局域网优先，中继兜底。** 桌面可以通过中继访问，也可以在同一局域网内直连。经过验证的
局域网地址会先于中继尝试；握手失败时自动回到中继，不会暴露配对密钥。中继失败时，
应用可以询问桌面候选地址并扫描当前私有网段，同时继续原有重试流程。维护边界见
[网络路由说明](docs/network-routing.md)。

**会话与记录。** 工作区、agent 及其实时状态、带增量更新的聊天历史，以及带常用按键的终端视图。
历史按游标分页，重连时从最后收到的位置继续，不会重放也不会跳过。

会话行可以左滑，但不会在行下方展开删除按钮；删除入口位于会话编辑页，并需要再次确认。
Mermaid 图表渲染期间保持预留高度，新消息也不会把用户从终端或源码视图拉回消息视图。

**模型与上下文。** 模型和 reasoning effort 取自桌面端从转录里读出的 `settings`，
这是权威来源；旧的桌面端不发这两项时，才回退到解析终端状态行。上下文用量没有别的来源，
仍然从状态行解析。认不出的行就不显示，不做猜测。

**后台 agent。** 当前会话里已被派发、尚未结束的子 agent 会列出来，
数据来自转录里的工具调用行。点进去可以读取这个子 agent 自己的记录——
桌面端按派发它的工具调用 id 分页返回那份转录，这是唯一能看清子 agent 做了什么的途径。

**静音与重启。** 可以按会话静音，静音记录存在桌面端，因此桌面端和别的设备上一并生效。
agent 卡住时可以让桌面端重启它：桌面端退出整个进程树、用同样的参数重新启动，
必要时再补一条续接的 prompt，全程发生在原来那个 pane 里。

**斜杠命令。** 在输入框里敲 `/` 会按当前 agent 过滤出它支持的命令，
按 agent 解析而不是从 Herdr API 取。只放只读和开菜单的命令；
任何清除、压缩或回退对话的命令都刻意不放。

**连接。** 应用在前台时，隧道静默 6 秒就发起一次探测，3 秒内没有回应即判定断开并重连；应用在后台时不探测。
发送或上传进行中不探测——一次大附件传输比这个阈值长是正常的。

**发送。** 消息走 `agent.prompt`；终端输入使用 bracketed paste 后跟回车。
已发出但未确认的请求——隧道断开、超时、HTTP 错误——会标记为「结果不确定」，**不会自动重发**，
由你核对记录或终端后再决定。

**授权按钮。** 终端里的编号菜单会变成可点按钮。发送按键前会重新读取终端，
问题、选项文本和高亮行必须全部一致；任何一项变化都会取消并刷新。
没有光标或勾选框的菜单——agent 输出里的普通编号列表——永远不会变成按钮。

**附件。** 每条消息最多 6 个文件、单个 16 MB，经同一条隧道上传到桌面，并在消息里以绝对路径引用。
图片走图片路由，其它文件走通用路由。

**新建会话。** 在你指定的目录启动 Claude Code、Codex 或 pi，默认使用当前所在目录。
先走手机桥允许的 `tab.create` + `agent.start`；只有那条路确实不可用时，才改用
直接拉起进程的 `layout.apply`。

**扫码配对。** 扫描 Alma「远程访问」页的二维码，也可以粘贴链接。

**统一移动端弹层。** 桌面设置、会话编辑与删除、新建会话、选择桌面和连接信息使用同一套
底部弹层结构。连接信息页统一命名为「连接与中继」，同时显示中继地址、访问范围和可复制的
配对凭据。

**本地提醒。** agent 等待你处理或已完成时发出通知，基于实时连接的状态差分。
不上传任何内容，也不依赖推送服务。

通知上可以直接操作：等待你处理的会话带「允许」「拒绝」，已完成的带内联回复。
按钮不是记忆下来的选项——点下去会重新读取终端，按文案重新确定该选哪一项；
问题变了、选项不再唯一、或者是个多选表单，都会拒绝并把会话打开让你自己确认。

**后台保活。** 默认只在 agent 工作期间短暂保持连接，结束就自动停止，通知栏不会常驻；
也可以选「始终」（通知栏常驻，受 Android 15 六小时限制）或「从不」。

**扫码之外的配对。** 系统里的 `alma://connect` 链接可以直接打开本应用并填好配对表单，
校验规则和粘贴链接完全一致。

**会话里的图片。** agent 转录里引用的图片会经同一条加密隧道取回后在会话里显示；
不会让消息触发任意网络请求。

**显示。** Markdown 渲染，会话内可随时切回源码；语言与时区默认跟随系统，也可手动指定。

**应用内更新。** 「设置 → 关于」会检查最新 GitHub Release；Android 壳负责下载，并在
打开系统安装器前校验发布页的 SHA-256。所有版本使用同一签名密钥，因此可以直接覆盖安装，
不会丢失已配对的桌面。下载器只接受本仓库的 Release 资产地址。

## 不做什么

没有远程桌面、浏览器远控、Alma 自身对话的客户端、模型/供应商配置，也没有云端推送。

聊天记录依赖 agent 通过 Herdr integration 上报会话 ID。刚启动的 agent 短暂没有 ID 是正常的，
消息模式会保留并提示等待；只有当 agent 已经开始工作、或者你发了消息之后仍然没有上报，
才会提示 integration 缺失。
对话历史和 agent 配置不在手机上留存，只有桌面端发过来的内容。

## 环境要求

- Alma 桌面已开启远程访问，中继可通过 HTTPS 访问
- 该桌面上的 Herdr 正在运行
- 要跟踪的 agent 已安装 Herdr integration
- 构建需要 Node 22+、JDK 21、Android SDK 36

## 中继

配对链接里带着中继地址，所以手机端不需要单独配置中继：
桌面用哪个中继，这个客户端就连哪个。开启端到端加密时（Alma 的默认设置），
中继只能看到密文，也永远看不到配对码。

Alma 自带 `relay.alma.now` 这个托管中继。如果你想把流量留在自己掌控的基础设施上，
或者想要一个更近的区域，可以自己部署 [yetone/alma-relay](https://github.com/yetone/alma-relay)。
它可以在 **Cloudflare Workers 免费套餐**上几分钟内跑起来：

```bash
git clone https://github.com/yetone/alma-relay && cd alma-relay
npm install
npx wrangler deploy        # 输出 https://alma-relay.<你>.workers.dev
```

用的是带 WebSocket 休眠的 SQLite Durable Objects，空闲配对几乎零成本，
TLS 和 `*.workers.dev` 域名一并带上。同一个仓库也支持 Docker 或挂在自有反向代理后面，
想用 VPS 也可以。部署完在桌面的「设置 → 远程访问 → 使用自建中继」里填地址，
然后**重新扫一次配对二维码**——切换前生成的链接不会带上新地址。

## 构建

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk

npm ci
npm run check          # 单元测试、类型检查、生产构建
npm run android:build  # 构建前端并打包 debug APK
```

产物在 `android/app/build/outputs/apk/debug/`。
`versionName` 来自 `android/app/build.gradle`，构建时注入到「关于」页面，两者不会不一致。

当前本 fork 的应用版本线是 `0.1.x`（本文撰写时为 `0.1.25`）。
旧的 `v0.4.213-*` 是 Capacitor 底座项目的标签，`v1.x` 是仓库历史标签；
新应用版本必须让 `package.json` 与 `android/app/build.gradle` 中的版本完全一致。

浏览器预览（无原生壳，节点只存在内存里，刷新即失效）：

```bash
npm run dev            # http://127.0.0.1:5174
```

## 目录

```
client/                 应用源码
  index.html            Vite 入口页面
  app/                  页面外壳：入口、页面、样式、导航
    main.tsx            挂载 App；返回键、深链与主题的接线
    App.tsx             页面与组件
    router.ts           界面与返回键共用的导航栈
    lifecycle.ts        前后台连接策略
    notify.ts           状态差分与本地通知
    updates.ts          对照 GitHub Release 的应用内更新检查
    version.ts          Vite 注入的构建信息
  core/                 状态机与它所说的协议
    model.ts            主机、会话、面板与消息的共享类型
    controller.ts       按桌面维护的路由、mutation 与主机生命周期
    protocol.ts         远端长生命周期响应的严格解析
    operations.ts       终端按键与菜单回答编码
    prompt.ts           终端菜单解析与漂移检测
    metrics.ts          本地卡顿检测与重试计数
  connection/           把字节送到桌面的一切
    transport.ts        端到端加密隧道：P-256 + HKDF + AES-GCM，HTTP/WS 多路复用
    frames.ts           内层帧编解码（JSON/base64 与可选二进制形式）
    crypto.ts           加密原语（改编自 lazyeo/alma-android，MIT）
    backoff.ts          有上限的重连节奏
    breaker.ts          对反复失败的直连地址退避
    deadline.ts         给可能永不结算的原生桥回调设上限
    keepalive.ts        前台服务开关
    network.ts          系统网络变更，切换网络后立刻重拨
    lan.ts              私有网段判断与局域网 WebSocket 端点
    localnet.ts         Android 上报的 Wi-Fi/以太网网段
    candidates.ts       严格校验桌面返回的局域网地址
    discovery.ts        有界网段扫描与配对身份校验
    lastroute.ts        记住已通过验证的直连地址
    lanprefs.ts         局域网发现开关
  session/              单个桌面的会话与转录
    session-loader.ts   会话身份的订阅、历史读取与预热
    session-rules.ts    settings 收敛与 transcript gap 分类
    session-info.ts     从 agent 状态行解析模型与上下文
    session-groups.ts   会话列表的分组标题与行
    session-title.ts    会话叫什么，以及为什么
    session-directory.ts 新会话的默认工作目录
    transcript-cache.ts 有上限的会话预热缓存
    media-cache.ts      按主机隔离、有上限的远端图片缓存
    local-media.ts      在本机拍摄或选择的图片
    timeline.ts         把转录折叠成读者真正要看的内容
    subagents.ts        运行中的后台 agent，从转录的工具调用行推导
    unread.ts           哪些会话有未看的新消息
    attachments.ts      上传与消息拼装
    drafts.ts           按桌面、按会话保存的草稿
    git-branch.ts       会话所在分支
  agents/               各编码 agent 的外观与可用命令
    agents.ts           产品名与品牌色
    agent-marks.ts      四个 agent 标记
    commands.ts         按 agent 提供输入框里的斜杠命令
    assets/             agent 图标素材
  ui/                   展示类组件
    Markdown.tsx        Markdown 渲染
    CodeBlock.tsx       代码块与复制按钮
    Mermaid.tsx         按需加载的 Mermaid 图表
    ImageViewer.tsx     全屏看图
    ScanPairs.tsx       扫码配对
  platform/             设备偏好与凭据
    prefs.ts            语言、时区、主题、Markdown
    i18n.ts             以中文原文为键的英文字典
    storage.ts          由 Android Keystore 保护的节点凭据
    pairing.ts          配对链接校验
    pending-link.ts     alma://connect 深链的暂存与读取
  app/styles.css        所有页面共用的一份样式表
android/                Capacitor 壳
  HerdrVaultPlugin      用 Android Keystore 加密节点凭据
  LocalNetworkPlugin    为局域网路由读取 Wi-Fi/以太网网段
  KeepAlivePlugin       可选的前台服务
  MainActivity          文件选择器、相机授权、通知渠道
client-tests/          单元测试、Playwright 流程、设备探针（本地）
```

## 发布

`.github/workflows/ci.yml` 会在每次推送到 `main` 时完成检查和构建。推送与版本一致的
`v*` 标签会创建公开 GitHub Release 并上传正式签名 APK。若签名 secrets 不可用，
工作流会直接失败，不会改用其他密钥发布。

完整发包手册（含 secrets 配置与发布后核验）见 [docs/releasing.md](docs/releasing.md)。

[查看发布运行记录](https://github.com/xiaotiyanlove-star/alma-android/actions/workflows/ci.yml)。

```bash
git tag -a v0.1.25 -m "Alma Android 0.1.25"
git push origin v0.1.25
```

标签必须与 `package.json`、`android/app/build.gradle` 中的版本一致，CI 会在打包前拒绝不一致。
要发布可覆盖升级的正式包，请配置 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、
`ANDROID_KEY_ALIAS` 和 `ANDROID_KEY_PASSWORD` 四个 secrets。

## 测试

```bash
npm test        # 单元测试：加密、帧编解码、会话、重试、菜单、偏好
npm run test:ui # 全部 Playwright 流程：逐页逐功能
npm run check   # 单元测试、类型检查与生产构建
npm run test:all # 交付前必跑：上面全部
```

**交付前跑 `npm run test:all`。** 它把单元测试、类型检查、构建和每个页面的
Playwright 流程串成一个序列，任何一步失败都会停下并报出是哪一项。

`npm run check` 只包含单元测试、类型检查与构建，不含 Playwright 流程；
`npm run test:ui` 只跑 Playwright 部分（CI 里先跑过 check，再用它补 UI）。

Playwright 流程驱动真实 UI，配合合成中继：完成加密握手、切换桌面、发送消息、
回答授权菜单、扫描生成的二维码、切换 Markdown。只使用合成配对码，不接触真实桌面。
`client-tests/live-*.ts` 下的脚本才需要真实桌面，默认不跑。

有一个守卫测试：任何通过 `t()` 或 `tWith()` 使用的中文串如果缺少英文条目，
测试就会失败。它会扫描 `client/` 下所有 `.ts` 和 `.tsx` 文件。

## 安全

- 配对链接等于该桌面的完整访问权。界面遮罩、保存后清空、不写日志，
  只存放在 `noBackupFilesDir` 下由 Keystore 加密的存储中；`allowBackup` 关闭。
- 只接受 HTTPS 中继。Android 仅为 E2E 密封的 `ws://` 局域网直连允许明文；
  该路径受手机当前子网和完整配对握手约束，并始终保留中继兜底。
- 模型输出的 Markdown 不渲染原始 HTML，图片只允许内联 data，避免消息触发任意网络请求。
- 传输断开会结束全部待处理请求；属于你已离开的会话的迟到响应会按身份丢弃，不会合并。

## 许可

MIT，见 [LICENSE](LICENSE)。第三方归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

本项目与 Alma、Herdr 官方均无隶属关系。

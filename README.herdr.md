# Herdr Remote（本 fork 的新客户端）

基于 [nanami-0713/alma-android](https://github.com/nanami-0713/alma-android) 的 Android 壳，
新增独立实现的 Herdr-only 多节点客户端。**不使用** `www/` 中内嵌的 Alma 官方 renderer。

## 后端与范围

- 连接对象：你 Mac 上现有的 Alma（Remote Access / 中继），不新增 Mac 服务。
- 每台 Alma Desktop 是一个节点；节点各自保存中转地址与配对密钥。
- 首版功能：节点管理、会话列表、聊天历史与实时增量、发送消息、终端画面与常用按键。
- 明确不做：自动批准权限、远程桌面、浏览器远控、云端推送、模型/供应商设置。

## 目录

```
client/            新客户端源码（入口 index.html → main.tsx）
  transport.ts     端到端加密隧道（P-256 + HKDF + AES-GCM）
  controller.ts    多节点状态机、聊天订阅、发送与不确定性处理
  storage.ts       持久化抽象（原生走 Keystore，浏览器预览走内存）
  App.tsx / styles.css
client-tests/      node:test 单元测试 + Playwright 合成端到端流程
android/           Capacitor 壳；HerdrVaultPlugin 用 Android Keystore 加密节点
www/               上游内嵌 renderer，仅作参考，不参与构建
```

## 构建

需要 JDK 21 与 Android SDK（`minSdk 23`、`targetSdk 35`）。

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export ANDROID_HOME=$HOME/Library/Android/sdk
```

```bash
npm ci
npm run check                 # 单元测试 + 类型检查 + 生产构建
npm run android:sync          # 构建 client 并同步进 android 工程
cd android && ./gradlew assembleDebug
```

调试 APK：`android/app/build/outputs/apk/debug/app-debug.apk`。

## 浏览器预览

```bash
npm run dev                   # http://127.0.0.1:5174
```

浏览器内没有原生 Keystore，节点只存在内存里，刷新即失效；顶部会显示一条提示。
这不影响 Android 构建。

## 合成端到端验证

```bash
node_modules/.bin/tsx client-tests/browser-smoke.ts
```

用 Playwright 拦截 `wss://relay.invalid`，在页面内完成真实握手、双节点切换、
聊天增量、终端按键；产物写入 `test-artifacts/`。只使用合成密钥，不连接真实 Alma。

## 安全要点

- 配对链接等同该 Mac 的完整访问凭据；界面遮罩、保存后清空、不写日志。
- Android 端密钥存在 `noBackupFilesDir`，由 Android Keystore 的 AES-GCM 密钥加密；
  `allowBackup=false`，避免随备份外流。
- 已发送但未确认成功的修改（发送、按键、终端输入）标记为“结果不确定”，
  在用户核对前不自动重发。
- 传输层断线会结束全部待处理请求，迟到响应按会话身份丢弃。

## 验证记录

- 38 项单元测试通过：双节点同名会话隔离、断线不确定性、迟到分页丢弃、并发遗忘不复活、非 2xx 修改请求标记不确定。
- Playwright 合成端到端：真实握手 + 双节点切换 + 聊天增量 + 终端按键，页面零 JS 错误。
- API 35 模拟器：APK 安装、启动，`HerdrVault` 插件注册成功。
- 真实节点只读验证：E2E 握手成功，Herdr 0.9.5 在线，3 个工作区；会话历史 260 条（tool/thinking/assistant/notice），终端 2142 字符；分页 `end == 下一页 start`，无重叠无空洞。

## 扫码与通知（0.1.2）

**扫码**：添加节点时点「扫码」，用相机对准 Alma「远程访问」里的二维码，
识别成功后自动填入配对链接并关闭对话框。相机权限在首次扫码时申请；
拒绝或没有相机时提示原因，仍可手工粘贴。解码用 jsQR（纯 JS），
不依赖系统 BarcodeDetector。

**通知**：agent 进入「需要你处理」或「已完成」时发本地通知。
只在应用运行时基于实时连接判断状态变化，不上传任何内容，无需服务端推送。
节点设置页可关闭，也可发送一条测试通知。Android 13+ 需授予通知权限。

## 后台保活与授权按钮（0.1.3）

**后台保活**：设置页可开启。开启后跑一个前台服务，让进程不被回收、网络不受后台限制，
这样退出应用后仍能收到提醒。只在原生侧维持服务，不做任何联网；通知栏常驻一条
「Herdr 正在后台保持连接」。关闭开关或卸载应用即停止。

**授权按钮**：agent 在终端里画出编号菜单时，消息视图上方出现「需要你选择」卡片，
选项按原文显示。点击后**先重新读取终端并逐字比对**问题、选项和高亮行，
一致才发送按键，否则取消并提示；避免画面已变化却点到别的选项。
多选菜单按空格切换，单选菜单移动光标后回车。

解析只接受「连续编号 1..n、至少 2 项、且有光标或勾选框、每项有实际文字」的菜单，
普通编号列表不会被误判成按钮。

## 已知限制

- 尚未在真实 Android 手机上验证（仅 API 35 模拟器）。
- 扫码的相机链路已在 APK 内验证可打开（emulated 摄像头），但未在物理相机前扫真实二维码。
- 通知在模拟器上已验证可显示；锁屏与勿扰模式下的表现未测试。
- 后台保活依赖前台服务；部分厂商 ROM 仍需手动允许自启动/忽略电池优化。
- 授权菜单解析基于终端文本；全新格式的菜单会回退成终端操作，不会猜测。
- 真实节点验证只做只读：未发送消息、未按键、未批准权限。
- 仅支持 Alpine/LAN 中继的 HTTPS 地址；LAN 直连尚未实现。
- 聊天适配依赖 Alma 的 `/api/herdr/chat`；不同 agent 的呈现差异未做逐一验证。
- 终端按键使用 `pane.send_keys`，文本使用 `pane.send_text` + Enter。

# Alma Android（中文说明）

在 [Alma](https://alma.now) 之上远程操作 [Herdr](https://herdr.dev) 的非官方 Android 客户端。
配对一台或多台 Alma 桌面后，可以在手机上阅读和操作 Claude Code、Codex、pi 等 coding agent。

本项目 fork 自 [nanami-0713/alma-android](https://github.com/nanami-0713/alma-android)，
保留其 Android 壳，但**替换掉内嵌的 Alma 官方 renderer**，改为独立编写的 Herdr 专用客户端。
连接、状态处理和全部界面都在 `client/` 里。

## 能做什么

- **多节点**：每台桌面独立配对，各自的中继与凭据；不同机器的同名 pane 不会串内容或串发送目标。
- **Herdr 会话**：工作区与 agent 列表、实时状态、聊天历史与增量更新、带常用按键的终端视图。
- **发送消息**：聊天走 `agent.prompt`，终端输入用 bracketed paste 加回车。
  已发出但未确认的操作会标记为「结果不确定」，不自动重发。
- **授权按钮**：终端里的编号菜单变成可点的按钮，但点击前会重新读取终端，
  问题、选项和高亮行全部一致才发送。
- **扫码配对**：扫描 Alma「远程访问」的二维码，也可以粘贴链接。
- **本地提醒**：agent 需要你处理或已完成时提醒；可选后台保持连接。
- **显示选项**：Markdown 渲染（会话内可随时切回源码）；语言与时区默认跟随系统。

## 不做什么

没有远程桌面、浏览器远控、模型/供应商配置、云端推送，也不是 Alma 自身对话的客户端。
手机只是桌面的一扇窗：模型、agent 进程和密钥都留在 Mac 上。

## 环境要求

- Alma 桌面已开启远程访问（中继可通过 HTTPS 访问）
- 该桌面上 Herdr 正在运行
- 目标 agent 已安装 Herdr integration（否则拿不到会话 ID，读不到聊天记录）
- Android 6.0+（API 23）；构建需要 JDK 21 与 Android SDK 35

## 构建

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export ANDROID_HOME=$HOME/Library/Android/sdk

npm ci
npm run check                 # 单元测试 + 类型检查 + 生产构建
npm run android:sync          # 构建 client/ 并同步进 Android 工程
cd android && ./gradlew assembleDebug
```

产物在 `android/app/build/outputs/apk/debug/`。

浏览器预览（无原生壳，节点只存在内存里）：

```bash
npm run dev                   # http://127.0.0.1:5174
```

## 目录

```
client/            应用源码
  transport.ts     端到端加密隧道（P-256 + HKDF + AES-GCM）与 HTTP/WS 多路复用
  controller.ts    多节点状态机、会话订阅、发送与授权
  prompt.ts        终端菜单解析与漂移检测
  crypto.ts        加密原语（改编自 lazyeo/alma-android，MIT）
  prefs.ts         语言、时区、Markdown 偏好
  App.tsx / styles.css
android/           Capacitor 壳
  HerdrVaultPlugin.java     用 Android Keystore 加密节点凭据
  KeepAlivePlugin/Service   可选的前台服务
client-tests/      单元测试、Playwright 流程、设备侧探针
www/               上游内嵌的 Alma renderer，仅供上游发布脚本使用，
                   本客户端不构建也不用它
```

## 测试

```bash
npm test                                                 # 44 项单元测试
node_modules/.bin/tsx client-tests/browser-smoke.ts      # 完整 UI 流程
node_modules/.bin/tsx client-tests/scan-flow-check.ts    # 扫码
node_modules/.bin/tsx client-tests/prompt-ui-check.ts    # 授权按钮
node_modules/.bin/tsx client-tests/markdown-ui-check.ts  # Markdown 与时区
```

Playwright 检查跑在 dev server 上，用模拟中继，只使用合成配对码，不接触真实桌面。

## 安全

- 配对链接等于该桌面的完整访问权：界面遮罩、保存后清空、不写日志，
  只存放在 Keystore 加密存储里。
- `android:allowBackup="false"`；除系统要求外禁止明文流量。
- 模型输出的 Markdown 不渲染原始 HTML，图片只允许内联 data URL。
- 传输断开会结束全部待处理请求，迟到响应按会话身份丢弃。

## 许可

MIT。见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
与 Alma、Herdr 官方均无隶属关系。

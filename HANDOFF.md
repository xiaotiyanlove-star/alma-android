# Herdr Remote 交接说明

写于 2026-11-02。原开发会话 `w1:p1` 已结束，后续在新会话继续。

## 当前状态

**仓库**：`/private/tmp/alma-android-dev`，分支 `feat/herdr-client`，
fork 自 `nanami-0713/alma-android` @ `v0.4.213-21`，**未推送**到
`xiaotiyanlove-star/alma-android`。

**已提交**：
- `e25e7f3` Herdr-only client: multi-node, QR pairing, local alerts
- `229547f` Background keep-alive and safe approval buttons

**工作区有未提交改动**，来自另一个并行会话（Markdown 渲染、时间/时区偏好）：
`client/App.tsx`、`client/styles.css`、`client/Markdown.tsx`、`client/prefs.ts`、
`client-tests/prefs.test.ts`。**不要擅自提交或回退这些文件**，先确认那个会话是否还在写。

## 架构

独立实现的轻客户端，入口 `client/index.html` → `client/main.tsx`。
`www/` 里的官方 renderer 不参与构建，仅作参考。

```
client/
  transport.ts    端到端加密隧道（P-256 + HKDF-SHA256 + AES-GCM）
  controller.ts   多节点状态机、聊天订阅、发送、不确定性处理、授权作答
  prompt.ts       终端编号菜单解析（保守，防误点）
  pairing.ts      配对链接解析
  storage.ts      持久化抽象；原生走 Keystore
  keepalive.ts    前台服务开关
  notify.ts       状态差分与本地通知
  ScanPairs.tsx   jsQR + getUserMedia 扫码
android/          Capacitor 壳
  HerdrVaultPlugin.java    Android Keystore AES-GCM 存储节点凭据
  KeepAlivePlugin.java     前台服务控制
  KeepAliveService.java    dataSync 类型前台服务
```

## 关键设计约束（改动前务必理解）

1. **发送结果不确定就不重发。** 已发出但未确认的修改类请求抛
   `OperationUncertainError`，客户端锁住发送，要求用户先核对。
2. **授权前必须重读。** `answerPrompt` 先 `pane.read`，用 `samePrompt`
   逐字比对问题/选项/光标，不一致就取消。
3. **编号列表不是菜单。** 解析器要求有光标或勾选框，否则不当按钮。
4. **会话身份 = hostId + paneId + sessionId。** 迟到的分页数据必须丢弃。
5. **不要改用户的默认配置。** 用户明确要求不要动 `~/.claude/hooks/`，
   保持与其他人环境一致，便于对照测试。

## 已解决的环境问题（不必重查）

- `CODEX_COMPANION_SESSION_ID` 会污染 Herdr 钩子读到的 `session_id`，
  导致 `transcript_not_found`。修法：`pane.clear_agent_authority` →
  `pane.report_agent_session` 写入正确 ID。新开会话不会踩到。
- 模拟器 webcam 转发产不出帧（`Unable to obtain video frame`），
  改用 `-camera-back emulated` 才正常。

## 验证方式

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export ANDROID_HOME=$HOME/Library/Android/sdk
npm run test           # 38 项单元测试
npm run dev            # http://127.0.0.1:5174
node_modules/.bin/tsx client-tests/browser-smoke.ts
node_modules/.bin/tsx client-tests/scan-flow-check.ts
node_modules/.bin/tsx client-tests/prompt-ui-check.ts
npm run android:sync && (cd android && ./gradlew assembleDebug)
```

真机节点只读验证：`client-tests/live-panes.ts`，需要 `ALMA_TEST_LINK` 环境变量。

## 尚未验证

- 真机扫码（模拟器无可用物理相机画面）
- 真实 blocked 状态下的授权卡片
- 后台保活在各厂商 ROM 上的实际效果
- 通知在锁屏/勿扰下的行为

## 已知遗留

- 官方中继对第三方客户端的政策未核实
- 仅支持 HTTPS 中继，局域网直连未实现
- debug APK 未做 release 签名与混淆

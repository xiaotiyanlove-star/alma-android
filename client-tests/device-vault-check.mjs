// Device-side check for the Android Keystore vault.
// Usage: adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
//        node client-tests/device-vault-check.mjs
// Verifies the native plugin round-trip from inside the running APK.
const target = process.env.CDP || 'http://127.0.0.1:9333'
const list = await (await fetch(`${target}/json/list`)).json()
const page = list.find((entry) => entry.type === 'page')
if (!page) throw new Error('no debuggable page found')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  waiter(message)
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
function evaluate(expression) {
  const requestId = ++id
  ws.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  return new Promise((resolve, reject) => pending.set(requestId, (message) => {
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  }))
}
const value = await evaluate(`(async () => {
  const cap = window.Capacitor
  if (!cap) return { error: 'no Capacitor bridge' }
  const plugin = cap.Plugins?.HerdrVault || cap.registerPlugin?.('HerdrVault')
  if (!plugin) return { error: 'HerdrVault not registered' }
  const probe = JSON.stringify([{ id: 'probe-' + Date.now(), name: 'probe', relayUrl: 'https://probe.invalid', connectCode: 'probe', addedAt: 1 }])
  await plugin.save({ value: probe })
  const back = await plugin.load()
  const same = back?.value === probe
  await plugin.save({ value: '[]' })
  return { platform: cap.getPlatform(), wrote: true, same }
})()`)
console.log(JSON.stringify({ page: page.url, ...value }))
ws.close()

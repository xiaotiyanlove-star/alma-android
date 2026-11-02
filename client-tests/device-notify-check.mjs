// Trigger a real local notification inside the installed APK and verify delivery.
const target = process.env.CDP || 'http://127.0.0.1:9334'
const list = await (await fetch(`${target}/json/list`)).json()
const page = list.find((entry) => entry.type === 'page')
if (!page) throw new Error('no debuggable page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const waiter = pending.get(message.id)
  if (waiter) { pending.delete(message.id); waiter(message) }
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
const evaluate = (expression) => {
  const requestId = ++id
  ws.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  return new Promise((resolve, reject) => pending.set(requestId, (message) =>
    message.error ? reject(new Error(JSON.stringify(message.error)))
      : message.result?.exceptionDetails ? reject(new Error(message.result.exceptionDetails.text))
      : resolve(message.result?.result?.value)))
}
const result = await evaluate(`(async () => {
  const cap = window.Capacitor
  if (!cap) return { error: 'no Capacitor' }
  const ln = cap.Plugins?.LocalNotifications || cap.registerPlugin?.('LocalNotifications')
  if (!ln) return { error: 'LocalNotifications missing' }
  const perm = await ln.checkPermissions()
  if (perm.display !== 'granted') await ln.requestPermissions()
  await ln.createChannel({ id: 'herdr-alerts', name: 'Herdr 提醒', description: 'Agent 需要你处理或已完成时提醒', importance: 3, vibration: true })
  await ln.schedule({ notifications: [{ id: 424242, title: '测试通知 · Herdr', body: '通知功能正常', channelId: 'herdr-alerts', smallIcon: 'ic_stat_herdr' }] })
  const after = await ln.checkPermissions()
  return { permBefore: perm.display, permAfter: after.display, scheduled: true }
})()`)
console.log(JSON.stringify(result))
ws.close()

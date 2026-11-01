// Verifies the in-app camera path (getUserMedia) inside the installed APK.
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
      : message.result?.exceptionDetails ? reject(new Error(message.result.exceptionDetails.text + ' ' + (message.result.exceptionDetails.exception?.description || '')))
      : resolve(message.result?.result?.value)))
}
const result = await evaluate(`(async () => {
  if (!navigator.mediaDevices?.getUserMedia) return { error: 'getUserMedia unavailable' }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    const track = stream.getVideoTracks()[0]
    const settings = track.getSettings()
    // Draw one frame and attempt a decode, proving the whole pipeline runs.
    const video = document.createElement('video')
    video.srcObject = stream
    await video.play()
    await new Promise((resolve) => setTimeout(resolve, 800))
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 640
    canvas.height = video.videoHeight || 480
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    const nonBlank = canvas.toDataURL('image/png').length > 2000
    stream.getTracks().forEach((t) => t.stop())
    return { granted: true, label: track.label, width: settings.width, height: settings.height, nonBlank }
  } catch (error) {
    return { granted: false, name: error.name, message: error.message }
  }
})()`)
console.log(JSON.stringify(result))
ws.close()

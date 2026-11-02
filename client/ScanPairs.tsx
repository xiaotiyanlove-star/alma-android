import jsQR from 'jsqr'
import { useEffect, useRef, useState } from 'react'
import { Camera, Loader2, X } from 'lucide-react'

/** Pull the pairing link out of raw QR text. Accepts a bare link or a wrapped payload. */
export function extractPairingLink(raw: string): string | null {
  const text = raw.trim()
  if (/^alma:\/\/connect\?/i.test(text)) return text
  const match = text.match(/alma:\/\/connect\?[^\s"'<>]+/i)
  return match ? match[0] : null
}

/** Decode one frame. Kept separate from the camera loop so tests can drive it directly. */
export function decodeFrame(data: Uint8ClampedArray, width: number, height: number): string | null {
  const result = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' })
  return result?.data ? extractPairingLink(result.data) : null
}

export function ScanPairing({ open, onClose, onScanned }: { open: boolean; onClose(): void; onScanned(link: string): void }) {
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(true)
  const [live, setLive] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const done = useRef(false)
  // The callback is a fresh closure on every render of the parent. Keeping it
  // in a ref means the camera effect below depends only on `open` — otherwise
  // each render tore the stream down and started it again, flashing "正在打开
  // 相机…" over and over and re-requesting the camera.
  const scanned = useRef(onScanned)
  scanned.current = onScanned

  useEffect(() => {
    if (!open) return
    let stream: MediaStream | undefined
    let frame = 0
    let cancelled = false
    done.current = false
    setError('')
    setStarting(true)
    setLive(false)

    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })

    const tick = () => {
      if (cancelled || done.current) return
      const video = videoRef.current
      if (video && video.readyState >= 2 && context) {
        const width = video.videoWidth
        const height = video.videoHeight
        if (width && height) {
          // Downscale: decoding speed matters more than resolving tiny codes.
          const scale = Math.min(1, 720 / Math.max(width, height))
          canvas.width = Math.round(width * scale)
          canvas.height = Math.round(height * scale)
          context.drawImage(video, 0, 0, canvas.width, canvas.height)
          try {
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
            const link = decodeFrame(pixels.data, canvas.width, canvas.height)
            if (link) {
              done.current = true
              scanned.current(link)
              return
            }
          } catch { /* one bad frame must not stop the loop */ }
        }
      }
      frame = requestAnimationFrame(tick)
    }

    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((media) => {
        if (cancelled) { media.getTracks().forEach((track) => track.stop()); return }
        stream = media
        const video = videoRef.current
        if (!video) return
        video.srcObject = media
        return video.play().then(() => { setStarting(false); setLive(true); frame = requestAnimationFrame(tick) })
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setStarting(false)
        const name = reason instanceof DOMException ? reason.name : ''
        setError(name === 'NotAllowedError' ? '相机权限被拒绝，请在系统设置里允许后重试。'
          : name === 'NotFoundError' ? '没有找到可用的相机。'
          : '无法启动相机，可以直接粘贴配对链接。')
      })

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [open])

  if (!open) return null
  return <div className="scan-backdrop" role="dialog" aria-modal="true" aria-label="扫描二维码">
    <div className="scan-sheet">
      <div className={`scan-viewport${live ? ' is-live' : ''}`}>
        <video ref={videoRef} className="scan-video" muted playsInline aria-label="相机预览" />
        <div className="scan-frame" aria-hidden="true" />
        {/* The header sits on the preview the way a camera app does, so the
            working area is the picture rather than a white dialog. */}
        <header className="scan-header">
          <h2>扫描二维码</h2>
          <button type="button" className="icon-button scan-close" aria-label="关闭扫描" onClick={onClose}><X size={20} /></button>
        </header>
        {starting && <div className="scan-status"><Loader2 className="spin" size={18} />正在打开相机…</div>}
        {error && <div className="scan-status is-error"><Camera size={18} />{error}</div>}
        <p className="scan-hint">把 Alma「远程访问」里的二维码放进方框内。也可以直接粘贴配对链接。</p>
      </div>
    </div>
  </div>
}

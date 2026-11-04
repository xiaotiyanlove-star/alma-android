import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { t } from './i18n'

/**
 * A full-screen picture, pinch- and double-tap to zoom.
 *
 * Written by hand rather than pulled in: the browser's own zoom is behind a
 * gesture WebView does not expose, and a library would bring a gesture surface
 * this needs none of — pan and scale on one element is a few dozen lines.
 *
 * The transform lives in a ref while a gesture is in flight and is committed to
 * state on release, so a drag does not re-render the tree on every frame.
 */
interface Transform { scale: number; x: number; y: number }
const IDENTITY: Transform = { scale: 1, x: 0, y: 0 }
const MAX_SCALE = 5

export function ImageViewer({ src, alt, onClose }: { src: string; alt?: string; onClose(): void }) {
  const [view, setView] = useState<Transform>(IDENTITY)
  const image = useRef<HTMLImageElement>(null)
  const gesture = useRef<{
    mode: 'pan' | 'pinch'
    startX: number
    startY: number
    baseX: number
    baseY: number
    baseScale: number
    distance: number
  } | null>(null)
  const lastTap = useRef(0)

  // Escape closes it, matching every other overlay in the app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function clamp(next: Transform): Transform {
    // Past 1x the picture may be dragged, but not so far that it leaves the
    // screen entirely; at or below 1x it recentres, which is what a double tap
    // to reset should do.
    if (next.scale <= 1) return IDENTITY
    const limit = { x: window.innerWidth * (next.scale - 1), y: window.innerHeight * (next.scale - 1) }
    return {
      scale: next.scale,
      x: Math.max(-limit.x, Math.min(limit.x, next.x)),
      y: Math.max(-limit.y, Math.min(limit.y, next.y)),
    }
  }

  function apply(next: Transform) {
    gesture.current = { ...(gesture.current ?? { mode: 'pan', startX: 0, startY: 0, baseX: 0, baseY: 0, baseScale: 1, distance: 0 }), baseX: next.x, baseY: next.y, baseScale: next.scale }
    setView(next)
    if (image.current) image.current.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.scale})`
  }

  function touchStart(event: React.TouchEvent) {
    if (event.touches.length === 2) {
      const [a, b] = [event.touches[0], event.touches[1]]
      gesture.current = {
        mode: 'pinch', startX: 0, startY: 0, baseX: view.x, baseY: view.y, baseScale: view.scale,
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      }
      return
    }
    const touch = event.touches[0]
    if (!touch) return
    gesture.current = { mode: 'pan', startX: touch.clientX, startY: touch.clientY, baseX: view.x, baseY: view.y, baseScale: view.scale, distance: 0 }
    // Double tap toggles between fitting the screen and 2.5x.
    const now = Date.now()
    if (now - lastTap.current < 300 && view.scale <= 1) apply({ scale: 2.5, x: 0, y: 0 })
    lastTap.current = now
  }

  function touchMove(event: React.TouchEvent) {
    const start = gesture.current
    if (!start) return
    if (start.mode === 'pinch' && event.touches.length === 2) {
      const [a, b] = [event.touches[0], event.touches[1]]
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      const scale = Math.max(1, Math.min(MAX_SCALE, start.baseScale * (distance / (start.distance || distance))))
      apply(clamp({ scale, x: start.baseX, y: start.baseY }))
      return
    }
    const touch = event.touches[0]
    if (!touch || start.mode !== 'pan' || start.baseScale <= 1) return
    apply(clamp({ scale: start.baseScale, x: start.baseX + (touch.clientX - start.startX), y: start.baseY + (touch.clientY - start.startY) }))
  }

  function touchEnd() {
    gesture.current = null
    apply(clamp(view))
  }

  return <div className="image-viewer" role="dialog" aria-modal="true" aria-label={alt || t('查看图片')} onClick={onClose}>
    <button type="button" className="image-viewer-close" title={t('关闭')} aria-label={t('关闭')} onClick={(event) => { event.stopPropagation(); onClose() }}><X size={22} /></button>
    <img
      ref={image}
      className="image-viewer-image"
      src={src}
      alt={alt ?? ''}
      draggable={false}
      onClick={(event) => event.stopPropagation()}
      onTouchStart={touchStart}
      onTouchMove={touchMove}
      onTouchEnd={touchEnd}
      onDoubleClick={(event) => { event.stopPropagation(); apply(view.scale > 1 ? IDENTITY : { scale: 2.5, x: 0, y: 0 }) }}
    />
    <p className="image-viewer-hint">{t('双指缩放，双击放大')}</p>
  </div>
}

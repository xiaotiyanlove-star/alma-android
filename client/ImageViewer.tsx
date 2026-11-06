import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react'
import { t, tWith } from './i18n'

/**
 * A full-screen picture: pinch and double-tap to zoom, swipe between pictures.
 *
 * Written by hand rather than pulled in: the browser's own zoom is behind a
 * gesture WebView does not expose, and a library would bring a gesture surface
 * this needs none of.
 *
 * The transform lives in a ref while a gesture is in flight and is committed to
 * state on release, so a drag does not re-render the tree on every frame.
 *
 * Pictures are addressed by *reference*, not by bytes. A transcript entry names
 * a desktop path (or, for a file this phone attached, a local path that maps to
 * a blob), and the bytes arrive through `resolve`. That is what makes swiping
 * work at all: the picture two to the right was never scrolled into view, so
 * nothing has fetched it yet.
 */
interface Transform { scale: number; x: number; y: number }
const IDENTITY: Transform = { scale: 1, x: 0, y: 0 }
const MAX_SCALE = 5
/** How far a horizontal swipe has to travel, in px, to change picture. */
const SWIPE_MIN_PX = 50
/** A flick shorter than this is still a swipe if it is fast enough. */
const SWIPE_MIN_PX_QUICK = 24
const SWIPE_MAX_MS = 700
/** How far a vertical drag has to travel before it puts the picture away. */
const DISMISS_MIN_PX = 120
/** A short downward flick is still a dismissal, because that is the gesture. */
const DISMISS_MIN_PX_QUICK = 40

export function ImageViewer({ src, alt, gallery, resolve, onClose }: {
  /** The picture that was tapped, as a transcript reference. */
  src: string
  alt?: string
  /** Every picture in the same transcript, in reading order. */
  gallery?: string[]
  resolve(reference: string): Promise<string>
  onClose(): void
}) {
  // A single picture, or one that is not in the list, gives a one-entry gallery
  // — which is exactly the behaviour before swiping existed.
  const sources = gallery && gallery.length ? gallery : [src]
  const [index, setIndex] = useState(() => Math.max(0, sources.indexOf(src)))
  const current = sources[index] ?? src
  const [view, setView] = useState<Transform>(IDENTITY)
  const [shown, setShown] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const image = useRef<HTMLImageElement>(null)
  /** Resolved bytes per reference, so swiping back costs nothing. */
  const cache = useRef(new Map<string, string>())
  const gesture = useRef<{
    mode: 'pan' | 'pinch' | 'swipe'
    startX: number
    startY: number
    baseX: number
    baseY: number
    baseScale: number
    distance: number
    startedAt: number
  } | null>(null)
  const lastTap = useRef(0)
  // A swipe ends in a click on some browsers; closing on that would make every
  // swipe the last thing the user sees of the picture they just moved to.
  const lastSwipe = useRef(0)

  // Resolve the picture on screen. The cache means a picture already fetched
  // paints immediately, and a failed one is not retried on every nudge.
  useEffect(() => {
    let alive = true
    const cached = cache.current.get(current)
    if (cached) { setShown(cached); setFailed(false); return () => { alive = false } }
    setShown(undefined)
    setFailed(false)
    void resolve(current).then((value) => {
      if (!alive) return
      cache.current.set(current, value)
      setShown(value)
    }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [current, resolve])

  /** Moves to a neighbouring picture, recentring the zoom with it. */
  function go(delta: number) {
    const next = index + delta
    if (next < 0 || next >= sources.length) return
    setIndex(next)
    setView(IDENTITY)
    gesture.current = null
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); return }
      // Arrow keys match the swipe on a device with a keyboard, and cost
      // nothing to support.
      if (event.key === 'ArrowLeft') go(-1)
      if (event.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

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
    gesture.current = { ...(gesture.current ?? { mode: 'pan', startX: 0, startY: 0, baseX: 0, baseY: 0, baseScale: 1, distance: 0, startedAt: 0 }), baseX: next.x, baseY: next.y, baseScale: next.scale }
    setView(next)
    if (image.current) image.current.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.scale})`
  }

  function touchStart(event: React.TouchEvent) {
    // Zoom and pan belong to the picture. The backdrop is the "close" target,
    // and a pinch starting there should not silently zoom what is behind it.
    const onPicture = event.target === image.current
    if (event.touches.length === 2) {
      if (!onPicture) return
      const [a, b] = [event.touches[0], event.touches[1]]
      gesture.current = {
        mode: 'pinch', startX: 0, startY: 0, baseX: view.x, baseY: view.y, baseScale: view.scale,
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), startedAt: Date.now(),
      }
      return
    }
    const touch = event.touches[0]
    if (!touch) return
    // At 1x a drag means "next picture"; past that it pans the zoomed one,
    // which is what the same finger movement means there.
    gesture.current = {
      mode: view.scale > 1 && onPicture ? 'pan' : 'swipe',
      startX: touch.clientX, startY: touch.clientY, baseX: view.x, baseY: view.y, baseScale: view.scale, distance: 0,
      startedAt: Date.now(),
    }
    // Double tap toggles between fitting the screen and 2.5x.
    const now = Date.now()
    if (onPicture && now - lastTap.current < 300 && view.scale <= 1) apply({ scale: 2.5, x: 0, y: 0 })
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
    // A swipe is not tracked here: there is nothing to transform, and reading
    // the delta on release is what makes a short flick work.
    if (!touch || start.mode !== 'pan' || start.baseScale <= 1) return
    apply(clamp({ scale: start.baseScale, x: start.baseX + (touch.clientX - start.startX), y: start.baseY + (touch.clientY - start.startY) }))
  }

  function touchEnd(event: React.TouchEvent) {
    const start = gesture.current
    gesture.current = null
    if (start?.mode === 'swipe') {
      const touch = event.changedTouches[0]
      if (!touch) return
      const dx = touch.clientX - start.startX
      const dy = touch.clientY - start.startY
      const quick = Date.now() - start.startedAt < SWIPE_MAX_MS
      const sideways = Math.abs(dx) > Math.abs(dy) * 1.5
      const downward = Math.abs(dy) > Math.abs(dx) * 1.5

      if (sideways) {
        // Horizontal only, by a clear margin. A diagonal drag is the user
        // trying to put the picture away or scroll, and turning it into a
        // change of picture would be a surprise.
        if (sources.length <= 1) return
        const threshold = quick ? SWIPE_MIN_PX_QUICK : SWIPE_MIN_PX
        const moved = dx <= -threshold ? 1 : dx >= threshold ? -1 : 0
        if (moved) { lastSwipe.current = Date.now(); go(moved) }
        return
      }
      // A vertical drag puts the picture away, the gesture a photo album taught
      // everyone. Both directions, because there is nothing above or below a
      // picture to scroll to — the drag has no other meaning here, and picking
      // one direction would make the other feel broken.
      //
      // Only while the picture is at fit-to-screen. Zoomed in, a vertical drag
      // is how the user reaches the top and bottom of what they just enlarged,
      // and taking that away — or worse, closing on it — would break the zoom.
      if (downward && view.scale <= 1) {
        const threshold = quick ? DISMISS_MIN_PX_QUICK : DISMISS_MIN_PX
        if (Math.abs(dy) >= threshold) { lastSwipe.current = Date.now(); onClose() }
      }
      return
    }
    apply(clamp(view))
  }

  return <div
    className="image-viewer"
    role="dialog"
    aria-modal="true"
    aria-label={alt || t('查看图片')}
    onClick={() => { if (Date.now() - lastSwipe.current < 400) return; onClose(); }}
    onTouchStart={touchStart}
    onTouchMove={touchMove}
    onTouchEnd={touchEnd}
  >
    <button type="button" className="image-viewer-close" title={t('关闭')} aria-label={t('关闭')} onClick={(event) => { event.stopPropagation(); onClose() }}><X size={22} /></button>
    {/* Only offered when there is a neighbour, so a single picture looks
        exactly as it did before. */}
    {sources.length > 1 && index > 0 && <button
      type="button"
      className="image-viewer-nav is-prev"
      title={t('上一张')}
      aria-label={t('上一张')}
      onClick={(event) => { event.stopPropagation(); go(-1) }}
    ><ChevronLeft size={22} /></button>}
    {sources.length > 1 && index < sources.length - 1 && <button
      type="button"
      className="image-viewer-nav is-next"
      title={t('下一张')}
      aria-label={t('下一张')}
      onClick={(event) => { event.stopPropagation(); go(1) }}
    ><ChevronRight size={22} /></button>}
    {failed
      ? <p className="image-viewer-failed">{t('这张图片无法显示')}</p>
      : !shown
        ? <Loader2 size={26} className="spin image-viewer-loading" aria-label={t('正在读取图片')} />
        : <img
          ref={image}
          className="image-viewer-image"
          src={shown}
          alt={alt ?? ''}
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => { event.stopPropagation(); apply(view.scale > 1 ? IDENTITY : { scale: 2.5, x: 0, y: 0 }) }}
        />}
    <p className="image-viewer-hint">{sources.length > 1
      ? tWith('{index}/{count} · 左右滑动切换，上下滑动关闭', { index: String(index + 1), count: String(sources.length) })
      : t('双指缩放，双击放大，上下滑动关闭')}</p>
  </div>
}

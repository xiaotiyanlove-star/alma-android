import { useEffect, useState } from 'react'
import { controller } from './controller'
import { t } from './i18n'

/** Loads an image via the already-paired desktop's encrypted tunnel. */
export function RemoteImage({ hostId, reference, alt = '', maxHeight = 360 }: {
  hostId: string
  reference: string
  alt?: string
  maxHeight?: number
}) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    setSrc('')
    setFailed(false)
    void controller.fetchSessionImage(hostId, reference)
      .then((data) => { if (alive) setSrc(data) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [hostId, reference])

  if (failed) return <span className="md-image-blocked">{t('图片暂时无法读取')}</span>
  if (!src) return <span className="md-image-loading" role="status">{t('正在读取图片…')}</span>
  return <img className="remote-image" src={src} alt={alt} loading="lazy" style={{ maxHeight, objectFit: 'contain' }} />
}

/**
 * Markdown renders its image node through the custom `img` component below;
 * use a private source scheme to distinguish local desktop references from
 * inline data URLs without ever allowing markdown to fetch arbitrary origins.
 */
export function herdrImageSource(reference: string): string {
  return `herdr-image:${encodeURIComponent(reference)}`
}

export function isHerdrImage(src?: string): boolean {
  return Boolean(src?.startsWith('herdr-image:'))
}

export function herdrImageReference(src: string): string {
  return decodeURIComponent(src.slice('herdr-image:'.length))
}

/** Extract absolute image paths printed by CLIs, just like Alma does. */
export function imagePathsIn(text: string): string[] {
  const re = /(?:^|[^A-Za-z0-9_./~\-])(~?\/(?!\/)[^\s`)'"<>，。；、！？）」》]+\.(?:png|jpe?g|gif|webp|heic))(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/gi
  const seen = new Set<string>()
  const found: string[] = []
  for (const match of text.matchAll(re)) {
    if (seen.has(match[1])) continue
    seen.add(match[1])
    found.push(match[1])
  }
  return found
}

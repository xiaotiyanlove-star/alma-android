import { useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { Capacitor } from '@capacitor/core'
import { Clipboard } from '@capacitor/clipboard'
import { t } from './i18n'
import { Mermaid, isMermaid } from './Mermaid'

/** The language react-markdown put on the code element, if any. */
function languageOf(children: ReactNode): string {
  const child = Array.isArray(children) ? children[0] : children
  const className = (child as { props?: { className?: string } } | null)?.props?.className ?? ''
  return /language-([\w+#-]+)/.exec(className)?.[1] ?? ''
}

/** The literal text of the code, whatever the tree looks like. */
function textOf(children: ReactNode): string {
  const child = Array.isArray(children) ? children[0] : children
  const value = (child as { props?: { children?: unknown } } | null)?.props?.children
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join('')
  return ''
}

/**
 * Copies a block of text, saying so for a moment afterwards.
 *
 * The clipboard goes through Capacitor on Android: `navigator.clipboard` is
 * unavailable in a WebView served from the app scheme, so a plain call would
 * silently fail there.
 */
export function CopyButton({ text, label, compact = false, className = '' }: { text: string; label?: string; compact?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      if (Capacitor.isNativePlatform()) await Clipboard.write({ string: text })
      else await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* Nothing useful to say: the text is still selectable. */ }
  }

  return <button type="button" className={`md-code-copy${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`} onClick={() => void copy()} aria-label={copied ? t('已复制') : (label ?? t('复制代码'))}>
    {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    {copied ? t('已复制') : compact ? '' : t('复制')}
  </button>
}

/** A fenced block with a header carrying its language and a copy button. */
export function CodeBlock({ children }: { children: ReactNode }) {
  const language = languageOf(children)
  const source = textOf(children)
  // A Mermaid fence is a picture, not code: it is drawn instead of printed.
  // Checked here rather than in Markdown so every fence — including one with
  // no language that still starts a diagram — takes the same path.
  if (isMermaid(language, source)) return <Mermaid source={source} label={language || undefined} />
  return <div className="md-code">
    <div className="md-code-bar">
      <span className="md-code-lang">{language || t('代码')}</span>
      <CopyButton text={textOf(children)} />
    </div>
    <pre tabIndex={0}>{children}</pre>
  </div>
}

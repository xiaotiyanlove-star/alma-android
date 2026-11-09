import { useEffect, useRef, useState } from 'react'
import { t } from '../platform/i18n'
import { CopyButton } from './CodeBlock'

/**
 * A Mermaid diagram from a fenced block.
 *
 * Mermaid is ~1 MB of parser and layout code, so it is imported on demand: a
 * conversation that never contains a diagram never downloads it, and the rest
 * of the app keeps its start-up cost. The import is a single shared promise, so
 * ten diagrams in one transcript pay for it once.
 *
 * Rendering is deliberately sandboxed in spirit rather than in fact: Mermaid
 * produces SVG from the diagram source, and the source comes from agent output.
 * `securityLevel: 'strict'` keeps it from following links or running script,
 * and the result is injected as markup only through `innerHTML` on an SVG root
 * — the same thing Mermaid's own `render` returns everywhere else.
 */

let loading: Promise<typeof import('mermaid').default> | null = null
let configuredTheme = ''

/** Loads and configures Mermaid once per process. */
function loadMermaid(theme: string): Promise<typeof import('mermaid').default> {
  loading ??= import('mermaid').then((module) => module.default)
  return loading.then((mermaid) => {
    if (configuredTheme !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'light' ? 'default' : 'dark',
        fontFamily: 'inherit',
        flowchart: { useMaxWidth: true, htmlLabels: false },
        suppressErrorRendering: true,
        sequence: { useMaxWidth: true },
        gantt: { useMaxWidth: true },
      })
      configuredTheme = theme
    }
    return mermaid
  })
}

export function isMermaid(language: string | undefined, source: string): boolean {
  if (language?.toLowerCase() === 'mermaid') return true
  // Some agents emit the diagram without naming the language.
  return /^\s*(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|sankey-beta|xychart-beta|block-beta)\b/m.test(source)
}

/** A diagram, or the source with a reason why it could not be drawn. */
export function Mermaid({ source, label }: { source: string; label?: string }) {
  const [svg, setSvg] = useState('')
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>()
  const [error, setError] = useState('')
  const [drawing, setDrawing] = useState(true)
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  const host = useRef<HTMLDivElement>(null)
  // Mermaid ids must be unique per render and valid as an id; a counter is the
  // only way to guarantee that across re-renders.
  const id = useRef(`mermaid-${Math.random().toString(36).slice(2, 9)}`)
  useEffect(() => {
    const root = document.documentElement
    const update = () => setTheme(root.dataset.theme === 'light' ? 'light' : 'dark')
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    setDrawing(true)
    setError('')
    void (async () => {
      try {
        const mermaid = await loadMermaid(theme)
        // `parse` must run first: `render` throws on bad input, and a thrown
        // error leaves Mermaid's DOM bookkeeping dirty for the next diagram.
        const result = await mermaid.render(id.current, source)
        if (!alive) return
        const probe = document.createElement('div')
        probe.innerHTML = result.svg
        const viewBox = probe.querySelector('svg')?.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
        if (viewBox && viewBox[2] > 0 && viewBox[3] > 0) {
          setDimensions({ width: viewBox[2], height: viewBox[3] })
        }
        setSvg(result.svg)
        setError('')
      } catch (failure) {
        if (!alive) return
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (alive) setDrawing(false)
      }
    })()
    return () => { alive = false }
  }, [source, theme])

  if (error) {
    // A broken diagram still has to be readable: show the source, and say why
    // it is not drawn rather than pretending it is not a diagram at all.
    return <figure className="mermaid-figure is-failed">
      <figcaption>{t('图表无法渲染')}<span className="mermaid-reason" title={error}>{error.split('\n')[0]}</span></figcaption>
      <pre tabIndex={0}><code>{source}</code></pre>
      <CopyButton text={source} />
    </figure>
  }

  const aspect = dimensions ? dimensions.width / dimensions.height : undefined
  return <figure className="mermaid-figure" style={aspect ? { aspectRatio: aspect } : undefined}>
    {(drawing || !svg) && <div className="mermaid-placeholder" ref={host} role="status" aria-label={t('正在绘制图表')} />}
    <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
    {!drawing && svg && <div className="mermaid-bar">
      {label && <span className="mermaid-label">{label}</span>}
      <CopyButton text={source} />
    </div>}
  </figure>
}

import { useEffect, useRef, useState } from 'react'
import { t } from './i18n'
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

/** Loads and configures Mermaid once per process. */
function loadMermaid(): Promise<typeof import('mermaid').default> {
  loading ??= import('mermaid').then((module) => {
    const mermaid = module.default
    mermaid.initialize({
      startOnLoad: false,
      // Agent output is untrusted; strict refuses script and click handlers.
      securityLevel: 'strict',
      theme: document.documentElement.dataset.theme === 'light' ? 'default' : 'dark',
      fontFamily: 'inherit',
      // The phone is narrow: let Mermaid use it rather than a fixed 800px.
      flowchart: { useMaxWidth: true, htmlLabels: false },
      // Mermaid injects its own red error bubble into the body; this component
      // already renders a failed diagram as a readable figure, so the bubble
      // would be a second, unclosable copy of the same news.
      suppressErrorRendering: true,
      sequence: { useMaxWidth: true },
      gantt: { useMaxWidth: true },
    })
    return mermaid
  })
  return loading
}

export function isMermaid(language: string | undefined, source: string): boolean {
  if (language?.toLowerCase() === 'mermaid') return true
  // Some agents emit the diagram without naming the language.
  return /^\s*(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|sankey-beta|xychart-beta|block-beta)\b/m.test(source)
}

/** A diagram, or the source with a reason why it could not be drawn. */
export function Mermaid({ source, label }: { source: string; label?: string }) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const [drawing, setDrawing] = useState(true)
  const host = useRef<HTMLDivElement>(null)
  // Mermaid ids must be unique per render and valid as an id; a counter is the
  // only way to guarantee that across re-renders.
  const id = useRef(`mermaid-${Math.random().toString(36).slice(2, 9)}`)

  useEffect(() => {
    let alive = true
    setDrawing(true)
    setError('')
    void (async () => {
      try {
        const mermaid = await loadMermaid()
        // `parse` must run first: `render` throws on bad input, and a thrown
        // error leaves Mermaid's DOM bookkeeping dirty for the next diagram.
        const result = await mermaid.render(id.current, source)
        if (!alive) return
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
  }, [source])

  if (error) {
    // A broken diagram still has to be readable: show the source, and say why
    // it is not drawn rather than pretending it is not a diagram at all.
    return <figure className="mermaid-figure is-failed">
      <figcaption>{t('图表无法渲染')}<span className="mermaid-reason" title={error}>{error.split('\n')[0]}</span></figcaption>
      <pre tabIndex={0}><code>{source}</code></pre>
      <CopyButton text={source} />
    </figure>
  }

  if (drawing || !svg) {
    return <figure className="mermaid-figure is-drawing" role="status" aria-label={t('正在绘制图表')}>
      <div className="mermaid-placeholder" ref={host} />
    </figure>
  }

  return <figure className="mermaid-figure">
    <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
    <div className="mermaid-bar">
      {label && <span className="mermaid-label">{label}</span>}
      <CopyButton text={source} />
    </div>
  </figure>
}

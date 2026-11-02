import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock'

/**
 * Rendered markdown for agent replies.
 *
 * Untrusted model output: raw HTML stays disabled (react-markdown's default),
 * links open through a sanitised path, and images are limited to inline data
 * so a message cannot make the app fetch arbitrary URLs.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>,
        img: ({ src, alt }) => typeof src === 'string' && src.startsWith('data:image/')
          ? <img src={src} alt={alt ?? ''} loading="lazy" />
          : <span className="md-image-blocked">[图片：{alt || '外部图片已隐藏'}]</span>,
        // Fenced blocks get a header with a copy button; an indented block
        // (no language) still does, because copying is the reason to have one.
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        code: ({ className, children }) => <code className={className}>{children}</code>,
        table: ({ children }) => <div className="md-table-wrap"><table>{children}</table></div>,
      }}
    >
      {text}
    </ReactMarkdown>
  </div>
}

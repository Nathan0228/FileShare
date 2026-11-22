import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components = {
  a: ({ href, children }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>,
  img: ({ alt }) => <span>{alt || '内嵌图片'}</span>,
  table: ({ children }) => <div className="overflow-x-auto"><table>{children}</table></div>,
}

export default function MarkdownPreview({ text }) {
  if (!text.trim()) return <p className="text-sm text-muted">此 Markdown 文件没有内容。</p>
  return (
    <article className="markdown-preview">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={(url, key) => key === 'href' && /^https?:\/\//i.test(url) ? url : ''}
      >{text}</Markdown>
    </article>
  )
}

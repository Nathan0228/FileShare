import { lazy, Suspense, useEffect, useState } from 'react'
import { Alert } from '../../components/ui/Feedback.jsx'
import { Modal } from '../../components/ui/Modal.jsx'
import { getErrorMessage } from '../../services/errors.js'
import { formatBytes } from '../transfers/file-data.js'
import { useTransfers } from '../transfers/index.js'

const MarkdownPreview = lazy(() => import('./MarkdownPreview.jsx'))

function LoadingPreview() {
  return <div role="status" className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted"><span className="button-spinner text-primary" />正在加载预览…</div>
}

function svgDataUrl(blob) {
  // A standalone data URL has an opaque origin if opened separately from the image.
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('无法读取 SVG 图片。'))
    reader.readAsDataURL(blob)
  })
}

export function FilePreviewDialog({ file, type, onClose }) {
  const { preview } = useTransfers()
  const [result, setResult] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    let objectUrl

    async function load() {
      const bytes = await preview(file, type.byteLimit, signal)
      signal.throwIfAborted()
      if (type.kind === 'markdown') {
        const text = new TextDecoder('utf-8', { fatal: true })
        try {
          setResult({ text: text.decode(bytes) })
        } catch {
          throw new Error('此 Markdown 文件无法按 UTF-8 读取。')
        }
        return
      }
      const blob = new Blob([bytes], { type: type.mime })
      const url = type.mime === 'image/svg+xml' ? await svgDataUrl(blob) : (objectUrl = URL.createObjectURL(blob))
      if (!signal.aborted) setResult({ url })
    }

    Promise.resolve().then(load).catch((error) => {
      if (!signal.aborted) setResult({ error: getErrorMessage(error) })
    })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file, preview, type])

  return (
    <Modal open className="ui-modal-wide" title={file.name} description={formatBytes(file.size)} onClose={onClose}>
      {!result ? <LoadingPreview /> : result.error ? <Alert tone="error" title="无法预览">{result.error}</Alert> :
        type.kind === 'markdown' ? (
          <Suspense fallback={<LoadingPreview />}><MarkdownPreview text={result.text} /></Suspense>
        ) : (
          <div className="grid place-items-center rounded-xl bg-canvas p-2 sm:p-4">
            <img
              src={result.url}
              alt={file.name}
              className="max-h-[70dvh] max-w-full object-contain"
              onError={() => setResult({ error: '浏览器无法显示此图片。请下载后打开。' })}
            />
          </div>
        )}
    </Modal>
  )
}

import { useRef } from 'react'
import FileIcon from '../../components/FileIcon.jsx'

export function FilePreviewTrigger({ name, extension, onPreview }) {
  const tap = useRef(null)
  const pointerType = useRef('')

  function handlePointerUp(event) {
    if (!event.isPrimary || event.pointerType === 'mouse') return
    const { clientX: x, clientY: y, timeStamp: time, pointerType: device } = event
    const last = tap.current
    if (last?.device === device && time - last.time <= 500 && Math.hypot(x - last.x, y - last.y) <= 32) {
      tap.current = null
      onPreview()
    } else {
      tap.current = { x, y, time, device }
    }
  }

  return (
    <button
      type="button"
      aria-label={`预览 ${name}`}
      title={name}
      className="flex min-w-0 touch-manipulation items-center gap-3 rounded-md text-start select-none hover:text-primary"
      onPointerDown={(event) => { pointerType.current = event.pointerType }}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { tap.current = null }}
      onDoubleClick={() => {
        if (pointerType.current === 'mouse' || !pointerType.current) onPreview()
      }}
      onClick={(event) => {
        if (event.detail === 0) onPreview()
      }}
    >
      <FileIcon filename={name} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">{name}</span>
        {extension && <span className="mt-0.5 hidden text-xs text-muted lg:block">{extension}</span>}
      </span>
    </button>
  )
}

import { memo, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from './pdf'
import type { PageInfo } from './types'

interface ThumbProps {
  pdf: PDFDocumentProxy
  index: number
  info: PageInfo
  selected: boolean
  current: boolean
  onClick: (index: number, additive: boolean, range: boolean) => void
  onDrop: (from: number, to: number) => void
}

const THUMB_WIDTH = 120

const Thumb = memo(function Thumb({ pdf, index, info, selected, current, onClick, onDrop }: ThumbProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const [over, setOver] = useState(false)
  const height = (info.h / info.w) * THUMB_WIDTH

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '400px 0px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let cancel: (() => void) | undefined
    ;(async () => {
      const page = await pdf.getPage(index + 1)
      if (cancelled || !canvasRef.current) return
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width })
      const canvas = canvasRef.current
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const task = page.render({ canvasContext: ctx, viewport })
      cancel = () => task.cancel()
      task.promise.catch(() => undefined)
    })()
    return () => {
      cancelled = true
      cancel?.()
    }
  }, [visible, pdf, index])

  return (
    <div
      ref={hostRef}
      className={`thumb ${selected ? 'selected' : ''} ${current ? 'current' : ''} ${over ? 'over' : ''}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/page', String(index))}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const from = Number(e.dataTransfer.getData('text/page'))
        if (!Number.isNaN(from)) onDrop(from, index)
      }}
      onClick={(e) => onClick(index, e.ctrlKey || e.metaKey, e.shiftKey)}
    >
      <canvas ref={canvasRef} style={{ width: THUMB_WIDTH, height }} />
      <span className="thumb-label">{index + 1}</span>
    </div>
  )
})

interface Props {
  pdf: PDFDocumentProxy
  pages: PageInfo[]
  selected: Set<number>
  current: number
  onClick: (index: number, additive: boolean, range: boolean) => void
  onMove: (from: number, to: number) => void
}

export function Thumbnails({ pdf, pages, selected, current, onClick, onMove }: Props) {
  return (
    <div className="thumbs">
      {pages.map((info, i) => (
        <Thumb
          key={i}
          pdf={pdf}
          index={i}
          info={info}
          selected={selected.has(i)}
          current={current === i}
          onClick={onClick}
          onDrop={onMove}
        />
      ))}
    </div>
  )
}

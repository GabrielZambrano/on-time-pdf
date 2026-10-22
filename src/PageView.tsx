import { memo, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { pdfjs } from './pdf'
import type { PDFDocumentProxy, RenderTask } from './pdf'
import type { BlockInfo, Hit, PageAction, PageInfo, Rect, Stroke, Tool, ToolOptions, Word } from './types'

interface Props {
  pdf: PDFDocumentProxy
  index: number
  info: PageInfo
  scale: number
  tool: Tool
  opts: ToolOptions
  hits: Hit[]
  activeHit: Hit | null
  strokes: Stroke[]
  getWords: (page: number) => Promise<Word[]>
  getBlock: (page: number, x: number, y: number) => Promise<BlockInfo | null>
  onStroke: (page: number, stroke: Stroke) => void
  onAction: (action: PageAction) => void
  onMessage: (text: string) => void
}

interface Editor {
  kind: 'edit' | 'paragraph' | 'text' | 'note'
  x: number
  y: number
  w: number
  h: number
  rect?: Rect
  rows?: number
  px?: number
  py?: number
  value: string
}

const CONTENT_TOOLS: Tool[] = ['recolor', 'edit', 'paragraph', 'text', 'image', 'highlight', 'draw', 'note', 'redact']

function normalize(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }
}

function contains(r: Rect, x: number, y: number) {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1
}

export const PageView = memo(function PageView(props: Props) {
  const { pdf, index, info, scale, tool, opts, hits, activeHit, strokes, getWords, getBlock, onStroke, onAction, onMessage } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [drag, setDrag] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null)
  const [live, setLive] = useState<Stroke | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const committed = useRef(false)
  const moving = useRef<{ px: number; py: number; x: number; y: number } | null>(null)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '900px 0px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let task: RenderTask | undefined
    let layer: InstanceType<typeof pdfjs.TextLayer> | undefined
    ;(async () => {
      const page = await pdf.getPage(index + 1)
      if (cancelled) return
      const viewport = page.getViewport({ scale })
      const dpr = window.devicePixelRatio || 1
      const canvas = canvasRef.current
      const text = textRef.current
      if (!canvas || !text) return
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      task = page.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
      try {
        await task.promise
      } catch {
        return
      }
      if (cancelled) return
      text.replaceChildren()
      text.style.setProperty('--scale-factor', String(viewport.scale))
      text.style.setProperty('--total-scale-factor', String(viewport.scale))
      layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport })
      layer.render().catch(() => undefined)
    })()
    return () => {
      cancelled = true
      task?.cancel()
      layer?.cancel()
    }
  }, [visible, pdf, index, scale])

  const toPt = (e: ReactPointerEvent) => {
    const box = overlayRef.current!.getBoundingClientRect()
    return { x: (e.clientX - box.left) / scale, y: (e.clientY - box.top) / scale }
  }

  const finishEditor = (commit: boolean) => {
    if (committed.current || !editor) return
    committed.current = true
    const current = editor
    setEditor(null)
    if (!commit || !current.value.trim()) return
    if (current.kind === 'edit' && current.rect) {
      onAction({ type: 'edit', page: index, rect: current.rect, text: current.value })
    } else if (current.kind === 'paragraph') {
      onAction({ type: 'paragraph', page: index, x: current.px ?? current.x, y: current.py ?? current.y, text: current.value })
    } else if (current.kind === 'text') {
      onAction({ type: 'text', page: index, x: current.x, y: current.y, text: current.value })
    } else if (current.kind === 'note') {
      onAction({ type: 'note', page: index, x: current.x, y: current.y, text: current.value })
    }
  }

  const openEditor = (next: Editor) => {
    committed.current = false
    setEditor(next)
  }

  const onDown = (e: ReactPointerEvent) => {
    if (tool === 'select' || editor) return
    if (info.rotation !== 0 && CONTENT_TOOLS.includes(tool)) {
      onMessage('La página está girada: devuélvala a 0° para editar su contenido')
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toPt(e)
    if (tool === 'draw') {
      setLive([[p.x, p.y]])
    } else if (tool === 'paragraph') {
      e.preventDefault()
      getBlock(index, p.x, p.y).then((b) => {
        if (!b) {
          onMessage('No hay un párrafo editable ahí. Si es un escaneo, use «Reconocer texto (OCR)»')
          return
        }
        if (b.mixed) onMessage('El párrafo mezcla estilos; el texto nuevo usará el estilo principal')
        openEditor({ kind: 'paragraph', x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0, rows: b.lines, px: p.x, py: p.y, value: b.text })
      })
    } else if (tool === 'text' || tool === 'note') {
      e.preventDefault()
      openEditor({ kind: tool, x: p.x, y: p.y, w: 220, h: 40, value: '' })
    } else {
      setDrag({ a: p, b: p })
    }
  }

  const onMove = (e: ReactPointerEvent) => {
    if (live) {
      const p = toPt(e)
      setLive([...live, [p.x, p.y]])
    } else if (drag) {
      setDrag({ ...drag, b: toPt(e) })
    }
  }

  const onUp = async (e: ReactPointerEvent) => {
    if (live) {
      if (live.length > 1) onStroke(index, live)
      setLive(null)
      return
    }
    if (!drag) return
    const rect = normalize(drag.a, toPt(e))
    setDrag(null)
    const tiny = rect.x1 - rect.x0 < 3 && rect.y1 - rect.y0 < 3
    if (tool === 'recolor') {
      const words = await getWords(index)
      const picked = tiny
        ? words.filter((w) => contains(w, drag.a.x, drag.a.y))
        : words.filter((w) => contains(rect, (w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2))
      if (!picked.length) {
        onMessage('No hay texto editable ahí. Si es un escaneo, use «Reconocer texto (OCR)»')
        return
      }
      onAction({
        type: 'recolor',
        page: index,
        rect: {
          x0: Math.min(...picked.map((w) => w.x0)),
          y0: Math.min(...picked.map((w) => w.y0)),
          x1: Math.max(...picked.map((w) => w.x1)),
          y1: Math.max(...picked.map((w) => w.y1)),
        },
      })
    } else if (tool === 'edit') {
      const words = await getWords(index)
      const picked = tiny
        ? words.filter((w) => contains(w, drag.a.x, drag.a.y))
        : words.filter((w) => contains(rect, (w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2))
      if (!picked.length) {
        onMessage('No hay texto editable ahí. Si es un escaneo, use «Reconocer texto (OCR)»')
        return
      }
      const same = picked.filter((w) => w.block === picked[0].block && w.line === picked[0].line)
      const union: Rect = {
        x0: Math.min(...same.map((w) => w.x0)),
        y0: Math.min(...same.map((w) => w.y0)),
        x1: Math.max(...same.map((w) => w.x1)),
        y1: Math.max(...same.map((w) => w.y1)),
      }
      openEditor({
        kind: 'edit',
        x: union.x0,
        y: union.y0,
        w: Math.max(union.x1 - union.x0, 60),
        h: union.y1 - union.y0,
        rect: union,
        value: same.map((w) => w.text).join(' '),
      })
    } else if (tool === 'image') {
      const r = tiny ? { x0: drag.a.x, y0: drag.a.y, x1: drag.a.x + 140, y1: drag.a.y + 70 } : rect
      onAction({ type: 'image', page: index, rect: r })
    } else if (tool === 'highlight') {
      const words = await getWords(index)
      const picked = tiny
        ? words.filter((w) => contains(w, drag.a.x, drag.a.y))
        : words.filter((w) => contains(rect, (w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2))
      if (picked.length) {
        const lines = new Map<string, Rect>()
        for (const w of picked) {
          const key = `${w.block}-${w.line}`
          const r = lines.get(key)
          lines.set(key, r ? { x0: Math.min(r.x0, w.x0), y0: Math.min(r.y0, w.y0), x1: Math.max(r.x1, w.x1), y1: Math.max(r.y1, w.y1) } : { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 })
        }
        onAction({ type: 'highlight', page: index, rects: [...lines.values()] })
      } else if (!tiny) {
        onAction({ type: 'highlight', page: index, rects: [rect] })
      }
    } else if (!tiny && tool === 'redact') {
      onAction({ type: 'redact', page: index, rect })
    }
  }

  const width = info.w * scale
  const height = info.h * scale
  const pageHits = hits.filter((h) => h.page === index)

  return (
    <div ref={hostRef} className="page" data-page={index} style={{ width, height }}>
      <canvas ref={canvasRef} className="page-canvas" />
      <div ref={textRef} className="textLayer" style={{ pointerEvents: tool === 'select' ? 'auto' : 'none' }} />
      <div
        ref={overlayRef}
        className={`overlay tool-${tool}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        {pageHits.map((h, i) => (
          <div
            key={i}
            className={`hit ${activeHit === h ? 'active' : ''}`}
            style={{ left: h.x0 * scale, top: h.y0 * scale, width: (h.x1 - h.x0) * scale, height: (h.y1 - h.y0) * scale }}
          />
        ))}
        {drag && (
          <div
            className={`drag drag-${tool}`}
            style={{
              left: Math.min(drag.a.x, drag.b.x) * scale,
              top: Math.min(drag.a.y, drag.b.y) * scale,
              width: Math.abs(drag.b.x - drag.a.x) * scale,
              height: Math.abs(drag.b.y - drag.a.y) * scale,
            }}
          />
        )}
        {(strokes.length > 0 || live) && (
          <svg className="ink" width={width} height={height}>
            {[...strokes, ...(live ? [live] : [])].map((s, i) => (
              <polyline
                key={i}
                points={s.map((p) => `${p[0] * scale},${p[1] * scale}`).join(' ')}
                fill="none"
                stroke={opts.color}
                strokeWidth={2 * scale}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </svg>
        )}
        {editor && (
          <div className="editor-wrap" style={{ left: editor.x * scale, top: editor.y * scale }} onPointerDown={(e) => e.stopPropagation()}>
            <div className="editor-bar">
              {(editor.kind === 'text' || editor.kind === 'note') && (
                <span
                  className="grip"
                  title="Arrastre para mover"
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId)
                    moving.current = { px: e.clientX, py: e.clientY, x: editor.x, y: editor.y }
                  }}
                  onPointerMove={(e) => {
                    const m = moving.current
                    if (m) setEditor({ ...editor, x: m.x + (e.clientX - m.px) / scale, y: m.y + (e.clientY - m.py) / scale })
                  }}
                  onPointerUp={() => (moving.current = null)}
                >
                  ✥ Mover
                </span>
              )}
              <button className="ok" onClick={() => finishEditor(true)} title="Aplicar (Enter)">
                ✓
              </button>
              <button onClick={() => finishEditor(false)} title="Cancelar (Esc)">
                ✕
              </button>
            </div>
            <textarea
              className={`inline-editor editor-${editor.kind}`}
              autoFocus
              rows={editor.kind === 'edit' ? 1 : editor.rows ?? 2}
              value={editor.value}
              placeholder={editor.kind === 'note' ? 'Nota…' : 'Escriba aquí…'}
              style={{
                minWidth: editor.w * scale,
                width: editor.kind === 'paragraph' ? editor.w * scale + 8 : undefined,
                height: editor.kind === 'edit' ? editor.h * scale + 6 : editor.kind === 'paragraph' ? editor.h * scale + 8 : undefined,
                fontSize:
                  editor.kind === 'edit'
                    ? editor.h * scale * 0.8
                    : editor.kind === 'paragraph'
                      ? (editor.h / (editor.rows ?? 1)) * scale * 0.78
                      : opts.size * scale,
                color: editor.kind === 'text' ? opts.color : undefined,
              }}
              onChange={(e) => setEditor({ ...editor, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') finishEditor(false)
                else if (e.key === 'Enter' && (editor.kind !== 'paragraph' || e.ctrlKey)) {
                  e.preventDefault()
                  finishEditor(true)
                }
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
})

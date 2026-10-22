import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import type { UpdateEvent } from './api'
import { CSS_UNITS, pdfjs } from './pdf'
import type { PDFDocumentProxy } from './pdf'
import { PageView } from './PageView'
import { Thumbnails } from './Thumbnails'
import { FormPanel } from './FormPanel'
import type { BlockInfo, DocInfo, DocState, Field, Hit, OpResult, PageAction, Stroke, Tool, ToolOptions, Word } from './types'

interface Toast {
  id: number
  text: string
  kind: 'info' | 'warn' | 'error'
}

const HIGHLIGHTS = ['#ffe600', '#7cfc00', '#ff9ecd', '#7fd4ff', '#ffb347', '#d7b6ff']
const INKS = ['#111111', '#d9480f', '#e03131', '#1c64f2', '#2b8a3e', '#7048e8']

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'select', label: 'Seleccionar', hint: 'Seleccionar y copiar texto' },
  { id: 'edit', label: 'Editar línea', hint: 'Clic en una palabra o arrastre sobre una línea entera para reemplazarla; una línea completa conserva la justificación' },
  { id: 'paragraph', label: 'Editar párrafo', hint: 'Clic en un párrafo: el texto se reacomoda al editarlo. Ctrl+Enter aplica, Esc cancela' },
  { id: 'recolor', label: 'Color de texto', hint: 'Arrastre sobre el texto: se pinta con el color de la barra sin moverlo' },
  { id: 'text', label: 'Añadir texto', hint: 'Clic donde quiera escribir' },
  { id: 'image', label: 'Imagen / firma', hint: 'Arrastre el área donde irá la imagen o la firma' },
  { id: 'highlight', label: 'Resaltar', hint: 'Arrastre sobre el texto a resaltar' },
  { id: 'draw', label: 'Dibujar', hint: 'Dibuje a mano alzada y pulse «Aplicar dibujo»' },
  { id: 'note', label: 'Nota', hint: 'Clic donde quiera la nota' },
  { id: 'redact', label: 'Censurar', hint: 'Arrastre el área a tachar; el contenido se elimina de forma permanente' },
]

let toastId = 0

export function App() {
  const [doc, setDoc] = useState<DocState | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [info, setInfo] = useState<DocInfo | null>(null)
  const [zoom, setZoom] = useState(1)
  const [tool, setTool] = useState<Tool>('select')
  const [opts, setOpts] = useState<ToolOptions>({ size: 14, color: '#111111', highlight: '#ffe600', fit: true, applyStyle: false })
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [current, setCurrent] = useState(0)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [hitIdx, setHitIdx] = useState(0)
  const [strokes, setStrokes] = useState<Record<number, Stroke[]>>({})
  const [toasts, setToasts] = useState<Toast[]>([])
  const [busy, setBusy] = useState(false)
  const [fields, setFields] = useState<Field[] | null>(null)
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateEvent | null>(null)
  const manualCheck = useRef(false)
  const viewerRef = useRef<HTMLDivElement>(null)
  const wordsCache = useRef(new Map<number, Word[]>())
  const pdfRef = useRef<PDFDocumentProxy | null>(null)

  const notify = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastId
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'info' ? 4000 : 9000)
  }, [])

  const loadDoc = useCallback(
    async (state: DocState) => {
      const bytes = await api.bytes()
      const loaded = await pdfjs.getDocument({ data: bytes }).promise
      const meta = (await api.query('info', {})) as unknown as DocInfo & OpResult
      pdfRef.current?.destroy()
      pdfRef.current = loaded
      wordsCache.current.clear()
      setPdf(loaded)
      setInfo(meta)
      setDoc(state)
      setHits([])
      setStrokes({})
      setFields(null)
      return meta
    },
    [],
  )

  const openFile = useCallback(
    async (file?: string) => {
      const res = await api.open(file)
      if (!res) return
      if (!res.ok || !res.state) {
        notify(res.error ?? 'No se pudo abrir el documento', 'error')
        return
      }
      setSelected(new Set())
      setCurrent(0)
      setQuery('')
      const meta = await loadDoc(res.state)
      if (meta.scannedPages > 0) {
        notify(`${meta.scannedPages} página(s) parecen escaneos sin texto. Use «Reconocer texto (OCR)» para buscar y seleccionar`, 'warn')
      }
    },
    [loadDoc, notify],
  )

  const run = useCallback(
    async (cmd: string, args: Record<string, unknown>, done?: string) => {
      setBusy(true)
      try {
        const res = await api.op(cmd, args)
        if (!res.ok || !res.state) {
          notify(res.error ?? 'La operación falló', 'error')
          return null
        }
        res.warnings?.forEach((w) => notify(w, 'warn'))
        await loadDoc(res.state)
        if (done) notify(done)
        return res
      } finally {
        setBusy(false)
      }
    },
    [loadDoc, notify],
  )

  const pagesTarget = useCallback(() => (selected.size ? [...selected].sort((a, b) => a - b) : [current]), [selected, current])

  const fitWidth = useCallback(() => {
    if (!info || !viewerRef.current) return
    const width = viewerRef.current.clientWidth - 90
    setZoom(Math.max(0.25, Math.min(4, width / info.pages[0].w / CSS_UNITS)))
  }, [info])

  const goTo = useCallback((page: number) => {
    viewerRef.current?.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: 'start' })
    setCurrent(page)
  }, [])

  const getWords = useCallback(async (page: number) => {
    const cached = wordsCache.current.get(page)
    if (cached) return cached
    const res = await api.query('words', { page })
    const words = (res.words as Word[]) ?? []
    wordsCache.current.set(page, words)
    return words
  }, [])

  const getBlock = useCallback(async (page: number, x: number, y: number) => {
    const res = await api.query('block_at', { page, x, y })
    return res.ok ? (res.block as BlockInfo) : null
  }, [])

  const onAction = useCallback(
    async (a: PageAction) => {
      if (a.type === 'edit') {
        await run('replace_text', { page: a.page, rect: a.rect, new: a.text, fit: opts.fit, ...(opts.applyStyle ? { color: opts.color, size: opts.size } : {}) })
      } else if (a.type === 'paragraph') {
        await run('paragraph', { page: a.page, x: a.x, y: a.y, text: a.text, ...(opts.applyStyle ? { color: opts.color, size: opts.size } : {}) })
      } else if (a.type === 'recolor') {
        await run('recolor', { page: a.page, rect: a.rect, color: opts.color }, 'Texto pintado')
      } else if (a.type === 'text') {
        await run('add_text', { page: a.page, x: a.x, y: a.y, text: a.text, size: opts.size, color: opts.color })
      } else if (a.type === 'image') {
        const [image] = await api.pickFiles('image', false)
        if (image) await run('add_image', { page: a.page, rect: a.rect, image })
      } else if (a.type === 'highlight') {
        await run('highlight', { page: a.page, rects: a.rects, color: opts.highlight })
      } else if (a.type === 'note') {
        await run('note', { page: a.page, x: a.x, y: a.y, text: a.text })
      } else if (a.type === 'redact') {
        if (window.confirm('El contenido bajo el área se eliminará de forma permanente. ¿Continuar?')) {
          await run('redact', { page: a.page, rects: [a.rect] })
        }
      }
    },
    [run, opts],
  )

  const applyStrokes = useCallback(async () => {
    for (const [page, list] of Object.entries(strokes)) {
      const ok = await run('draw', { page: Number(page), strokes: list, color: opts.color, width: 2 })
      if (!ok) return
    }
    notify('Dibujo aplicado')
  }, [strokes, run, opts.color, notify])

  const addStroke = useCallback((page: number, stroke: Stroke) => {
    setStrokes((s) => ({ ...s, [page]: [...(s[page] ?? []), stroke] }))
  }, [])

  const undo = useCallback(async () => {
    const state = await api.undo()
    if (state) await loadDoc(state)
  }, [loadDoc])

  const redo = useCallback(async () => {
    const state = await api.redo()
    if (state) await loadDoc(state)
  }, [loadDoc])

  const save = useCallback(async () => {
    const res = await api.saveAs()
    if (res) {
      setDoc(res.state)
      notify(`Copia guardada: ${res.file}`)
    }
  }, [notify])

  const rotate = (angle: number) => run('rotate', { pages: pagesTarget(), angle })

  const removePages = async () => {
    const pages = pagesTarget()
    if (!window.confirm(`¿Eliminar ${pages.length} página(s)?`)) return
    if (await run('delete_pages', { pages })) setSelected(new Set())
  }

  const extractPages = async () => {
    const res = await api.exportTo('extract', { pages: pagesTarget() })
    if (!res) return
    if (res.ok) notify(`Páginas extraídas en ${res.file}`)
    else notify(res.error ?? 'No se pudo extraer', 'error')
  }

  const splitDoc = async () => {
    const res = await api.split()
    if (!res) return
    if (res.ok) notify(`Se crearon ${res.files?.length ?? 0} archivos`)
    else notify(res.error ?? 'No se pudo dividir', 'error')
  }

  const mergeFiles = async () => {
    const files = await api.pickFiles('pdf', true)
    if (!files.length) return
    setBusy(true)
    const res = await api.merge(files)
    setBusy(false)
    if (!res.ok || !res.state) {
      notify(res.error ?? 'No se pudo unir', 'error')
      return
    }
    await loadDoc(res.state)
    notify(`Se unieron ${files.length} documento(s) al final`)
  }

  const movePage = async (from: number, to: number) => {
    if (!info || from === to) return
    const order = info.pages.map((_, i) => i)
    order.splice(from, 1)
    order.splice(to, 0, from)
    await run('reorder', { order })
    setSelected(new Set())
  }

  const runOcr = async () => {
    await run('ocr', { lang: 'spa' }, 'Reconocimiento de texto completado')
  }

  const doSearch = async () => {
    if (!query.trim()) {
      setHits([])
      return
    }
    const res = await api.query('search', { query })
    const found = (res.hits as Hit[]) ?? []
    setHits(found)
    setHitIdx(0)
    if (found.length) goTo(found[0].page)
    else notify('Sin resultados')
  }

  const stepHit = (dir: number) => {
    if (!hits.length) return
    const next = (hitIdx + dir + hits.length) % hits.length
    setHitIdx(next)
    goTo(hits[next].page)
  }

  const openForm = async () => {
    const res = await api.query('fields', {})
    setFields((res.fields as Field[]) ?? [])
  }

  const applyForm = async (values: Record<string, unknown>) => {
    await run('fill', { values }, 'Campos aplicados')
  }

  const onThumbClick = (index: number, additive: boolean, range: boolean) => {
    setSelected((prev) => {
      const next = new Set(additive ? prev : [])
      if (range) {
        const [a, b] = [Math.min(current, index), Math.max(current, index)]
        for (let i = a; i <= b; i++) next.add(i)
      } else if (additive && prev.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
    goTo(index)
  }

  const onScroll = () => {
    const host = viewerRef.current
    if (!host) return
    const middle = host.getBoundingClientRect().top + host.clientHeight / 3
    let best = 0
    host.querySelectorAll<HTMLElement>('.page').forEach((el) => {
      if (el.getBoundingClientRect().top <= middle) best = Number(el.dataset.page)
    })
    setCurrent(best)
  }

  useEffect(() => {
    api.version().then(setVersion)
    return api.onUpdate((u) => {
      if (u.status === 'none' && manualCheck.current) notify('Ya tiene la última versión')
      if (u.status === 'error' && manualCheck.current) notify(u.message ?? 'No se pudo buscar actualizaciones', 'warn')
      if (u.status !== 'checking') manualCheck.current = u.status === 'progress' || u.status === 'downloading' ? manualCheck.current : false
      setUpdate(u)
    })
  }, [notify])

  useEffect(() => {
    api.initialFile().then((file) => {
      if (file) openFile(file)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT'
      if (!(e.ctrlKey || e.metaKey) || typing) return
      const k = e.key.toLowerCase()
      if (k === 'o') openFile()
      else if (k === 's') save()
      else if (k === 'z') undo()
      else if (k === 'y') redo()
      else if (k === 'f') document.getElementById('search-box')?.focus()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openFile, save, undo, redo])

  useEffect(() => {
    const el = viewerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setZoom((z) => Math.max(0.25, Math.min(4, z * (e.deltaY < 0 ? 1.1 : 0.9))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [pdf])

  useEffect(() => {
    if (info && zoom === 1) fitWidth()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf])

  const scale = zoom * CSS_UNITS
  const activeHit = hits[hitIdx] ?? null
  const hasStrokes = useMemo(() => Object.values(strokes).some((l) => l.length), [strokes])
  const toolHint = TOOLS.find((t) => t.id === tool)?.hint

  const dropFile = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file && file.name.toLowerCase().endsWith('.pdf')) openFile(api.pathForFile(file))
  }

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={dropFile}>
      <header className="topbar">
        <div className="brand">
          On Time <b>PDF</b>
        </div>
        <div className="group">
          <button onClick={() => openFile()}>Abrir</button>
          <button className="primary" disabled={!doc} onClick={save}>
            Guardar copia
          </button>
        </div>
        <div className="group">
          <button disabled={!doc?.canUndo || busy} onClick={undo}>
            Deshacer
          </button>
          <button disabled={!doc?.canRedo || busy} onClick={redo}>
            Rehacer
          </button>
        </div>
        <div className="group">
          <button disabled={!doc || busy} onClick={() => rotate(-90)} title="Girar a la izquierda">
            ↺
          </button>
          <button disabled={!doc || busy} onClick={() => rotate(90)} title="Girar a la derecha">
            ↻
          </button>
          <button disabled={!doc || busy} onClick={removePages}>
            Eliminar
          </button>
          <button disabled={!doc || busy} onClick={extractPages}>
            Extraer
          </button>
          <button disabled={!doc || busy} onClick={splitDoc}>
            Dividir
          </button>
          <button disabled={!doc || busy} onClick={mergeFiles}>
            Unir
          </button>
        </div>
        <div className="group">
          <button disabled={!doc || busy} onClick={runOcr}>
            Reconocer texto (OCR)
          </button>
          <button disabled={!doc?.name || !info?.hasForm} onClick={openForm}>
            Formulario
          </button>
        </div>
        <div className="group search">
          <input
            id="search-box"
            value={query}
            disabled={!doc}
            placeholder="Buscar…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.shiftKey && hits.length ? stepHit(-1) : hits.length && query ? stepHit(1) : doSearch())}
          />
          <button disabled={!hits.length} onClick={() => stepHit(-1)}>
            ‹
          </button>
          <button disabled={!hits.length} onClick={() => stepHit(1)}>
            ›
          </button>
          {hits.length > 0 && (
            <span className="muted">
              {hitIdx + 1}/{hits.length}
            </span>
          )}
        </div>
        <div className="group">
          <button
            onClick={() => {
              manualCheck.current = true
              api.checkUpdates()
            }}
            title="Buscar una versión nueva en GitHub"
          >
            Buscar actualización
          </button>
        </div>
        <div className="group zoom">
          <button disabled={!doc} onClick={() => setZoom((z) => Math.max(0.25, z / 1.2))}>
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button disabled={!doc} onClick={() => setZoom((z) => Math.min(4, z * 1.2))}>
            +
          </button>
          <button disabled={!doc} onClick={fitWidth}>
            Ajustar
          </button>
        </div>
      </header>

      {update && (update.status === 'ready' || update.status === 'downloading' || update.status === 'progress') && (
        <div className="update-bar">
          {update.status === 'ready' ? (
            <>
              <span>La versión {update.version} está lista.</span>
              <button className="primary" onClick={() => api.installUpdate()}>
                Reiniciar e instalar
              </button>
            </>
          ) : (
            <span>Descargando actualización{update.percent !== undefined ? ` ${update.percent}%` : '…'}</span>
          )}
        </div>
      )}

      <nav className="tools">
        {TOOLS.map((t) => (
          <button key={t.id} className={tool === t.id ? 'active' : ''} disabled={!doc} onClick={() => setTool(t.id)} title={t.hint}>
            {t.label}
          </button>
        ))}
        <span className="sep" />
        {tool === 'highlight' && (
          <div className="swatches" title="Color del resaltado">
            <span>Resaltar con</span>
            {HIGHLIGHTS.map((c) => (
              <button key={c} className={`swatch ${opts.highlight === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setOpts({ ...opts, highlight: c })} />
            ))}
            <input type="color" value={opts.highlight} onChange={(e) => setOpts({ ...opts, highlight: e.target.value })} />
          </div>
        )}
        {['recolor', 'text', 'draw', 'edit', 'paragraph'].includes(tool) && (
          <div className="swatches" title="Color del texto o del trazo">
            <span>{tool === 'recolor' ? 'Pintar con' : 'Color'}</span>
            {INKS.map((c) => (
              <button key={c} className={`swatch ${opts.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setOpts({ ...opts, color: c })} />
            ))}
            <input type="color" value={opts.color} onChange={(e) => setOpts({ ...opts, color: e.target.value })} />
          </div>
        )}
        <label>
          Tamaño
          <input type="number" min={4} max={200} value={opts.size} onChange={(e) => setOpts({ ...opts, size: Number(e.target.value) || 12 })} />
        </label>
        <label>
          Color
          <input type="color" value={opts.color} onChange={(e) => setOpts({ ...opts, color: e.target.value })} />
        </label>
        <label>
          Resaltado
          <input type="color" value={opts.highlight} onChange={(e) => setOpts({ ...opts, highlight: e.target.value })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={opts.fit} onChange={(e) => setOpts({ ...opts, fit: e.target.checked })} />
          Ajustar texto reemplazado
        </label>
        <label className="check">
          <input type="checkbox" checked={opts.applyStyle} onChange={(e) => setOpts({ ...opts, applyStyle: e.target.checked })} />
          Usar color y tamaño de la barra al editar
        </label>
        {tool === 'draw' && (
          <>
            <button className="primary" disabled={!hasStrokes || busy} onClick={applyStrokes}>
              Aplicar dibujo
            </button>
            <button disabled={!hasStrokes} onClick={() => setStrokes({})}>
              Descartar
            </button>
          </>
        )}
      </nav>

      <main className="body">
        {pdf && info ? (
          <>
            <aside className="side thumbs-panel">
              <Thumbnails pdf={pdf} pages={info.pages} selected={selected} current={current} onClick={onThumbClick} onMove={movePage} />
            </aside>
            <div className="viewer" ref={viewerRef} onScroll={onScroll}>
              <div className="pages">
                {info.pages.map((p, i) => (
                  <PageView
                    key={i}
                    pdf={pdf}
                    index={i}
                    info={p}
                    scale={scale}
                    tool={tool}
                    opts={opts}
                    hits={hits}
                    activeHit={activeHit}
                    strokes={strokes[i] ?? []}
                    getWords={getWords}
                    getBlock={getBlock}
                    onStroke={addStroke}
                    onAction={onAction}
                    onMessage={(t) => notify(t, 'warn')}
                  />
                ))}
              </div>
            </div>
            {fields && <FormPanel fields={fields} onApply={applyForm} onClose={() => setFields(null)} />}
          </>
        ) : (
          <div className="empty">
            <h1>
              On Time <b>PDF</b>
            </h1>
            <p>Editor de PDF personal. Todo funciona en este equipo, sin internet.</p>
            <button className="primary big" onClick={() => openFile()}>
              Abrir un PDF
            </button>
            <p className="muted">o arrastre un archivo a esta ventana</p>
          </div>
        )}
      </main>

      <footer className="status">
        <span>{doc ? `${doc.name}${doc.dirty ? ' · modificado' : ''}` : 'Sin documento'}</span>
        {info && (
          <span>
            Página {current + 1} de {info.pages.length}
            {selected.size > 0 ? ` · ${selected.size} seleccionada(s)` : ''}
          </span>
        )}
        <span>{version ? `v${version}` : ''}</span>
        <span className="hint">{busy ? 'Procesando…' : doc ? toolHint : ''}</span>
      </footer>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}

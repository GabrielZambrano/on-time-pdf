export type Tool = 'select' | 'edit' | 'paragraph' | 'recolor' | 'text' | 'image' | 'highlight' | 'draw' | 'note' | 'redact'

export interface PageInfo {
  w: number
  h: number
  rotation: number
}

export interface DocInfo {
  pages: PageInfo[]
  scannedPages: number
  hasForm: boolean
}

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface Word extends Rect {
  text: string
  block: number
  line: number
}

export interface Hit extends Rect {
  page: number
}

export interface Field {
  page: number
  name: string
  type: string
  value: unknown
  choices: string[] | null
}

export interface DocState {
  name: string
  original: string
  version: string
  canUndo: boolean
  canRedo: boolean
  dirty: boolean
}

export interface OpResult {
  ok: boolean
  error?: string
  warnings?: string[]
  state?: DocState
  [key: string]: unknown
}

export interface ToolOptions {
  size: number
  color: string
  highlight: string
  fit: boolean
  applyStyle: boolean
}

export interface BlockInfo extends Rect {
  text: string
  size: number
  lines: number
  mixed: boolean
}

export type Stroke = [number, number][]

export type PageAction =
  | { type: 'edit'; page: number; rect: Rect; text: string }
  | { type: 'paragraph'; page: number; x: number; y: number; text: string }
  | { type: 'recolor'; page: number; rect: Rect }
  | { type: 'text'; page: number; x: number; y: number; text: string }
  | { type: 'image'; page: number; rect: Rect }
  | { type: 'highlight'; page: number; rects: Rect[] }
  | { type: 'note'; page: number; x: number; y: number; text: string }
  | { type: 'redact'; page: number; rect: Rect }

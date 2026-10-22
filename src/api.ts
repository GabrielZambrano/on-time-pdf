import type { DocState, OpResult } from './types'

export interface UpdateEvent {
  status: 'checking' | 'none' | 'downloading' | 'progress' | 'ready' | 'error'
  version?: string
  percent?: number
  message?: string
}

interface Bridge {
  open(file?: string): Promise<{ ok: boolean; error?: string; state?: DocState } | null>
  initialFile(): Promise<string | null>
  version(): Promise<string>
  checkUpdates(): Promise<void>
  installUpdate(): Promise<void>
  onUpdate(callback: (payload: UpdateEvent) => void): () => void
  bytes(): Promise<Uint8Array>
  state(): Promise<DocState | null>
  op(cmd: string, args: Record<string, unknown>): Promise<OpResult>
  merge(files: string[]): Promise<OpResult>
  query(cmd: string, args: Record<string, unknown>): Promise<OpResult>
  undo(): Promise<DocState | null>
  redo(): Promise<DocState | null>
  saveAs(): Promise<{ file: string; state: DocState } | null>
  exportTo(cmd: string, args: Record<string, unknown>): Promise<(OpResult & { file: string }) | null>
  split(ranges?: number[][]): Promise<(OpResult & { files?: string[] }) | null>
  pickFiles(kind: 'pdf' | 'image', multi: boolean): Promise<string[]>
  pathForFile(file: File): string
}

declare global {
  interface Window {
    onTime: Bridge
  }
}

export const api = window.onTime

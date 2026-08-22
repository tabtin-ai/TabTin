import type { PtyWritable } from './PtyWriteChannel'

export interface PtyHostDisposable {
  dispose(): void
}

export interface PtyHostExitEvent {
  exitCode: number | null
  signal?: number
}

export interface PtyHostSpawnedEvent {
  pid: number
}

export interface PtyHostSpawnRequest {
  shell: string
  cwd: string
  cols: number
  rows: number
  env: Record<string, string>
  termName?: string
}

export interface PtyHostSession extends PtyWritable {
  readonly pid: number
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  pauseOutput(): void
  resumeOutput(): void
  onSpawned(handler: (event: PtyHostSpawnedEvent) => void): PtyHostDisposable
  onData(handler: (data: string) => void): PtyHostDisposable
  onExit(handler: (event: PtyHostExitEvent) => void): PtyHostDisposable
}

export interface PtyHostClient {
  spawn(request: PtyHostSpawnRequest): PtyHostSession
}

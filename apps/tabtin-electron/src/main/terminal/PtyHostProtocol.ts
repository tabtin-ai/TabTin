import type { PtyHostSpawnRequest } from './PtyHost'

export type PtyHostCommand =
  | { kind: 'spawn'; request: PtyHostSpawnRequest }
  | { kind: 'write'; data: string }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'kill'; signal?: string }
  | { kind: 'pause-output' }
  | { kind: 'resume-output' }

export type PtyHostEvent =
  | { kind: 'ready' }
  | { kind: 'spawned'; pid: number }
  | { kind: 'data'; data: string }
  | { kind: 'exit'; exitCode: number | null; signal?: number }
  | { kind: 'error'; message: string }

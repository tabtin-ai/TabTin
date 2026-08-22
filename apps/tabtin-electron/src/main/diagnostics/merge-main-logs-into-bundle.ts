/**
 * 落盘前把 main.log 及归档注入诊断 zip（主进程本地读盘，避免大日志过 IPC）。
 */

import JSZip from 'jszip'
import { redact } from '../../shared/diagnostics-redact'
import { readMainProcessLogSnapshot } from './read-main-logs'

export interface MergeMainLogsResult {
  buffer: Buffer
  mainLogAttached: boolean
  oldLogAttached: boolean
  note?: string
}

export async function mergeMainLogsIntoBundleBuffer(zipBuffer: Buffer): Promise<MergeMainLogsResult> {
  const zip = await JSZip.loadAsync(zipBuffer)
  const snapshot = await readMainProcessLogSnapshot()

  zip.remove('main.log')
  zip.remove('main.old.log')
  for (let index = 1; index <= 5; index += 1) {
    zip.remove(`main.${index}.log`)
  }
  zip.remove('main.log.note.txt')

  let mainLogAttached = false
  let oldLogAttached = false

  if (snapshot.mainLog) {
    zip.file('main.log', redact(snapshot.mainLog))
    mainLogAttached = true
  }
  const archivedLogs = snapshot.archivedLogs
    ?? (snapshot.oldLog ? [{ fileName: 'main.old.log', content: snapshot.oldLog }] : [])
  for (const item of archivedLogs) {
    zip.file(item.fileName, redact(item.content))
    oldLogAttached = true
  }
  if (!mainLogAttached && !oldLogAttached) {
    zip.file('main.log.note.txt', snapshot.note ?? '主进程日志不可用。')
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return {
    buffer,
    mainLogAttached,
    oldLogAttached,
    note: mainLogAttached || oldLogAttached ? undefined : snapshot.note,
  }
}

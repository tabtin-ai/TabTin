/**
 * 读取 electron-log 落盘的 main.log / main.N.log（主进程专用）。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import electronLog from 'electron-log'
import type { DiagnosticsLogSnapshot } from '../../shared/diagnostics-types'

/** 单个日志文件最多取尾部 8MB。 */
export const MAX_MAIN_LOG_TAIL_BYTES = 8 * 1024 * 1024
const MAIN_LOG_ARCHIVE_COUNT = 5

export function resolveMainLogPath(): string | null {
  try {
    const file = electronLog.transports.file.getFile()
    return file?.path ?? null
  } catch {
    return null
  }
}

function archivedLogPath(mainLogPath: string, index: number): string {
  const parsed = path.parse(mainLogPath)
  return path.join(parsed.dir, `${parsed.name}.${index}${parsed.ext}`)
}

/** 读文件；超过上限时只取尾部，读不到返回 null。 */
export async function readTail(filePath: string, maxBytes: number): Promise<string | null> {
  try {
    const stat = await fsp.stat(filePath)
    if (stat.size === 0) return null
    if (stat.size <= maxBytes) {
      return await fsp.readFile(filePath, 'utf-8')
    }
    const handle = await fsp.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      await handle.read(buf, 0, maxBytes, stat.size - maxBytes)
      const mb = Math.round(maxBytes / 1024 / 1024)
      return `…[已截断，仅保留最后 ${mb}MB]\n${buf.toString('utf-8')}`
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

export async function readMainProcessLogSnapshot(): Promise<DiagnosticsLogSnapshot> {
  const mainLogPath = resolveMainLogPath()
  if (!mainLogPath) {
    return {
      available: false,
      logDir: null,
      mainLog: null,
      oldLog: null,
      archivedLogs: [],
      note: '主进程日志文件不可用（开发模式下 electron-log 文件通道默认关闭）。',
    }
  }
  const logDir = path.dirname(mainLogPath)
  const archivePaths = Array.from({ length: MAIN_LOG_ARCHIVE_COUNT }, (_, i) => ({
    fileName: `main.${i + 1}.log`,
    filePath: archivedLogPath(mainLogPath, i + 1),
  }))
  const legacyOldLogPath = path.join(logDir, 'main.old.log')
  const [mainLog, ...archiveContents] = await Promise.all([
    readTail(mainLogPath, MAX_MAIN_LOG_TAIL_BYTES),
    ...archivePaths.map((item) => readTail(item.filePath, MAX_MAIN_LOG_TAIL_BYTES)),
    readTail(legacyOldLogPath, MAX_MAIN_LOG_TAIL_BYTES),
  ])
  const legacyOldLog = archiveContents[archiveContents.length - 1] ?? null
  const archivedLogs = archivePaths
    .map((item, index) => ({ fileName: item.fileName, content: archiveContents[index] }))
    .filter((item): item is { fileName: string; content: string } => item.content !== null)
  if (legacyOldLog && archivedLogs.length === 0) {
    archivedLogs.push({ fileName: 'main.old.log', content: legacyOldLog })
  }
  const oldLog = archivedLogs[0]?.content ?? null
  const available = mainLog !== null || archivedLogs.length > 0
  return {
    available,
    logDir,
    mainLog,
    oldLog,
    archivedLogs,
    note: available
      ? undefined
      : '未找到主进程日志内容（开发模式下 main.log 通常为空，仅打包版本写文件）。',
  }
}

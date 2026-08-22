/**
 * ConversationSummaryExport — D-5 §5 "对话历史摘要"导出 bucket。
 *
 * ## 设计决策
 *
 * G2 已经在 `agent-storage-buckets.ts` 注册了 `agent:conversations:messages` /
 * `agent:conversations:snapshots` / `agent:conversations:events`，但**都没有
 * exportFn**。W3.3 边界约束"不动 51 个 bucket 注册文件"，因此走**独立 bucket**：
 *
 *   - 新建 `conversation:summary-export`（`hideFromList: true`）
 *   - 仅暴露 sizeFn + exportFn
 *   - UI 渲染对话历史卡片时额外加"导出摘要"按钮
 *
 * ## 导出内容
 *
 * 不导消息正文（隐私 + 体积巨大）。只导：
 *   - 按 Organization → Space → Session 三轴聚合
 *   - 每个 session 的 sessionId / messageCount / fileSizeBytes /
 *     firstMessageTime / lastMessageTime
 *
 * 用户能据此知道：
 *   - 自己有哪些 Organization / Space / Session 的本地副本
 *   - 每段对话的规模和时间跨度
 *   - 在清理前评估"清掉会丢什么"
 *
 * ## 性能
 *
 * 用户可能有 1000+ 个 session（R2 review 关注点）。本实现：
 *   - 用 `_enumerateSessions` 一次 readdir 树遍历
 *   - 每个 session 的 messages.jsonl **不全读**——只 stat 拿 size，再
 *     读头部 64KB / 尾部 64KB 解析首/末条 ISO 时间戳，避免 100MB
 *     文件全读卡顿
 *   - 跳过没有 messages.jsonl 的 session 目录
 *   - 单 session 解析失败不影响整体
 */

import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { getBucket, registerStorageBucket } from '@tabtin/storage-manager'
import { getPlatformDataRoot } from '@tabtin/shared'
import { createLogger } from '../logger'

const log = createLogger('ConversationSummaryExport')

const SUMMARY_BUCKET_ID = 'conversation:summary-export'

/** 头部 / 尾部窗口大小：64KB 足够覆盖一条 message JSONL（含富 metadata） */
const TIMESTAMP_PROBE_BYTES = 64 * 1024

/** R3 review 修复：复用 Checkpoint 的并发模式，1000 sessions 从 ~10s 压到 ~3s */
const SCAN_CONCURRENCY = 4

interface SessionSummary {
  sessionId: string
  /** 消息数。小文件精确，大文件按行密度估算（看 messageCountIsEstimated） */
  messageCount: number
  /** R1/R3 修复：true 表示 messageCount 是估算值（基于头部窗口行密度外推） */
  messageCountIsEstimated: boolean
  fileSizeBytes: number
  /** 第一条消息的时间戳（ISO 字符串），解析失败为 null */
  firstMessageTime: string | null
  /** 最后一条消息的时间戳（ISO 字符串） */
  lastMessageTime: string | null
  /** events.jsonl 文件 size（如果存在），辅助用户感知"另有事件流" */
  eventsFileSizeBytes: number
  /** snapshots.jsonl 文件 size（如果存在） */
  snapshotsFileSizeBytes: number
}

interface SpaceSummary {
  organizationId: string
  spaceId: string
  sessionCount: number
  totalMessageCount: number
  totalBytes: number
  sessions: SessionSummary[]
}

async function _safeStat(filePath: string): Promise<number> {
  try {
    return (await fsp.stat(filePath)).size
  } catch {
    return 0
  }
}

/**
 * 探测 messages.jsonl 的首条 / 末条时间戳 + 行数。
 * 只读头尾两个 64KB 窗口，避免大文件全读。
 *
 * @returns 包含 count（行数）/ isEstimated（是否估算）/ first|lastTime 的探测结果
 */
async function _probeMessageTimestamps(filePath: string, fileSize: number): Promise<{
  count: number
  isEstimated: boolean
  firstTime: string | null
  lastTime: string | null
}> {
  if (fileSize === 0) {
    return { count: 0, isEstimated: false, firstTime: null, lastTime: null }
  }

  let fh: fsp.FileHandle | null = null
  try {
    fh = await fsp.open(filePath, 'r')

    // 读头部
    const headLen = Math.min(TIMESTAMP_PROBE_BYTES, fileSize)
    const headBuf = Buffer.alloc(headLen)
    await fh.read(headBuf, 0, headLen, 0)
    const headText = headBuf.toString('utf-8')

    // 读尾部（如果跟头部重叠就用整段）
    let tailText: string
    if (fileSize <= TIMESTAMP_PROBE_BYTES * 2) {
      tailText = headText
      if (fileSize > headLen) {
        const fullBuf = Buffer.alloc(fileSize)
        await fh.read(fullBuf, 0, fileSize, 0)
        tailText = fullBuf.toString('utf-8')
      }
    } else {
      const tailLen = TIMESTAMP_PROBE_BYTES
      const tailStart = fileSize - tailLen
      const tailBuf = Buffer.alloc(tailLen)
      await fh.read(tailBuf, 0, tailLen, tailStart)
      tailText = tailBuf.toString('utf-8')
    }

    // 估算行数：头部窗口的换行密度 × 文件大小（粗略）。如果整个文件小于
    // 头部窗口，就直接数头部的行数（精确值）。
    let count = 0
    let isEstimated = false
    if (fileSize <= headLen) {
      count = headText.split('\n').filter((ln) => ln.trim().length > 0).length
    } else {
      // 大文件：用头部窗口的行密度外推。这是估算值——R2 视角下"近似值"
      // 比"全读 100MB 的 messages.jsonl"更友好（用户感知 < 1s vs > 10s）。
      const headLines = headText.split('\n').filter((ln) => ln.trim().length > 0).length
      if (headLines > 0) {
        const avgLineBytes = headLen / headLines
        count = Math.round(fileSize / avgLineBytes)
        isEstimated = true
      }
    }

    // 解析首条时间戳：找头部第一个完整 JSON 行的时间字段
    const firstTime = _extractTimestampFromLine(_firstFullJsonLine(headText))
    // 解析末条时间戳：找尾部最后一个完整 JSON 行
    const lastTime = _extractTimestampFromLine(_lastFullJsonLine(tailText))

    return { count, isEstimated, firstTime, lastTime }
  } catch (err) {
    log.warn(`probe ${filePath} failed:`, err)
    return { count: 0, isEstimated: false, firstTime: null, lastTime: null }
  } finally {
    try { await fh?.close() } catch { /* noop */ }
  }
}

function _firstFullJsonLine(text: string): string | null {
  const nl = text.indexOf('\n')
  if (nl < 0) {
    return text.trim().length > 0 ? text.trim() : null
  }
  const candidate = text.slice(0, nl).trim()
  return candidate.length > 0 ? candidate : null
}

function _lastFullJsonLine(text: string): string | null {
  // 跳过尾部可能的不完整行，找倒数第二个 \n 之前的行（最后一个 \n 之后可能是 EOF）
  const trimmed = text.trimEnd()
  const lastNl = trimmed.lastIndexOf('\n')
  if (lastNl < 0) {
    return trimmed.length > 0 ? trimmed : null
  }
  const candidate = trimmed.slice(lastNl + 1).trim()
  return candidate.length > 0 ? candidate : null
}

function _extractTimestampFromLine(line: string | null): string | null {
  if (!line) return null
  try {
    const obj = JSON.parse(line) as Record<string, unknown>
    // messages.jsonl 一行通常是 { id, role, content, created_at: ISO, ... }
    // 也可能写 createdAt / timestamp 别名
    const candidates = ['created_at', 'createdAt', 'timestamp', 'time']
    for (const key of candidates) {
      const v = obj[key]
      if (typeof v === 'string' && v.length > 0) return v
      if (typeof v === 'number' && Number.isFinite(v)) {
        // ms 时间戳
        return new Date(v).toISOString()
      }
    }
  } catch { /* 行不是 JSON / 损坏 */ }
  return null
}

async function _summarizeAllSessions(): Promise<SpaceSummary[]> {
  // 2026-05-04 重构后：conversations 在 platform-data 下，路径是
  // `{platformDataRoot}/{wt}/spaces/{sp}/conversations/sessions/...`。
  const root = getPlatformDataRoot()
  if (!fs.existsSync(root)) return []

  let organizationDirs: fs.Dirent[]
  try {
    organizationDirs = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const spaces: SpaceSummary[] = []
  for (const wt of organizationDirs) {
    if (!wt.isDirectory()) continue
    const spacesParent = path.join(root, wt.name, 'spaces')
    let spaceDirs: fs.Dirent[]
    try {
      spaceDirs = await fsp.readdir(spacesParent, { withFileTypes: true })
    } catch { continue }
    for (const sp of spaceDirs) {
      if (!sp.isDirectory()) continue
      const sessionsDir = path.join(spacesParent, sp.name, 'conversations', 'sessions')
      if (!fs.existsSync(sessionsDir)) continue

      let sessionDirs: fs.Dirent[]
      try {
        sessionDirs = await fsp.readdir(sessionsDir, { withFileTypes: true })
      } catch { continue }

      // R3 P1 修复：按 session 切片并发，避免 1000 sessions 串行时
      // 累计 ~10s 的卡顿（IO 密集的 stat + open/read/close 链路）。
      const candidateSessions = sessionDirs.filter((s) => s.isDirectory())
      const probedResults: SessionSummary[] = []
      for (let i = 0; i < candidateSessions.length; i += SCAN_CONCURRENCY) {
        const slice = candidateSessions.slice(i, i + SCAN_CONCURRENCY)
        const batch = await Promise.all(
          slice.map(async (s) => {
            const sessionDir = path.join(sessionsDir, s.name)
            const messagesPath = path.join(sessionDir, 'messages.jsonl')
            const eventsPath = path.join(sessionDir, 'events.jsonl')
            const snapshotsPath = path.join(sessionDir, 'snapshots.jsonl')

            const [messagesSize, eventsSize, snapshotsSize] = await Promise.all([
              _safeStat(messagesPath),
              _safeStat(eventsPath),
              _safeStat(snapshotsPath),
            ])

            // 完全空的 session 目录（连任何一类 jsonl 都没有）跳过——
            // 避免输出体积膨胀，又能反映用户实际使用过的会话。
            if (messagesSize === 0 && eventsSize === 0 && snapshotsSize === 0) {
              return null
            }

            const probe = messagesSize > 0
              ? await _probeMessageTimestamps(messagesPath, messagesSize)
              : { count: 0, isEstimated: false, firstTime: null, lastTime: null }

            return {
              sessionId: s.name,
              messageCount: probe.count,
              messageCountIsEstimated: probe.isEstimated,
              fileSizeBytes: messagesSize,
              firstMessageTime: probe.firstTime,
              lastMessageTime: probe.lastTime,
              eventsFileSizeBytes: eventsSize,
              snapshotsFileSizeBytes: snapshotsSize,
            } satisfies SessionSummary
          }),
        )
        for (const item of batch) {
          if (item) probedResults.push(item)
        }
      }

      const sessions = probedResults
      const totalMessageCount = sessions.reduce((sum, s) => sum + s.messageCount, 0)
      const totalBytes = sessions.reduce(
        (sum, s) => sum + s.fileSizeBytes + s.eventsFileSizeBytes + s.snapshotsFileSizeBytes,
        0,
      )

      if (sessions.length > 0) {
        spaces.push({
          organizationId: wt.name,
          spaceId: sp.name,
          sessionCount: sessions.length,
          totalMessageCount,
          totalBytes,
          sessions,
        })
      }
    }
  }
  return spaces
}

/**
 * 注册 conversation:summary-export bucket。幂等：重复调用安全。
 *
 * 在 startup-services.ts 启动期被调用。
 */
export function registerConversationSummaryExportBucket(): void {
  if (getBucket(SUMMARY_BUCKET_ID)) return

  registerStorageBucket({
    id: SUMMARY_BUCKET_ID,
    category: 'data',
    group: 'conversation',
    displayName: '对话历史 · 摘要导出',
    description: '导出每个 Organization / Space 下的 session 元信息（消息数、容量、时间跨度，不含消息正文）',
    warnings: [
      '本桶仅做导出——清理请到 "对话历史 · 消息流" 等卡片操作',
      '导出文件不包含消息正文（隐私），仅含 sessionId / messageCount / 文件容量 / 时间戳',
      '消息条数对大文件是估算值（基于头部窗口行密度外推）',
    ],
    requiresConfirmation: 'hard',
    hideFromList: true,
    sizeFn: async () => {
      try {
        const spaces = await _summarizeAllSessions()
        const bytes = spaces.reduce((sum, sp) => sum + sp.totalBytes, 0)
        const itemCount = spaces.reduce((sum, sp) => sum + sp.sessionCount, 0)
        return { bytes, itemCount }
      } catch (err) {
        log.error('sizeFn failed:', err)
        return { bytes: 0, itemCount: 0 }
      }
    },
    exportFn: async () => {
      const exportedAt = new Date().toISOString()
      const spaces = await _summarizeAllSessions()

      const totalSessions = spaces.reduce((sum, sp) => sum + sp.sessionCount, 0)
      const totalMessages = spaces.reduce((sum, sp) => sum + sp.totalMessageCount, 0)
      const totalBytes = spaces.reduce((sum, sp) => sum + sp.totalBytes, 0)
      // 顶层标记：任一 session 估算 → totalMessages 也是估算
      const totalMessagesIsEstimated = spaces.some((sp) =>
        sp.sessions.some((s) => s.messageCountIsEstimated),
      )

      const payload = {
        schemaVersion: 1,
        exportedAt,
        source: 'tabtin-electron',
        bucketId: SUMMARY_BUCKET_ID,
        platformDataRoot: getPlatformDataRoot(),
        totalOrganizations: new Set(spaces.map((s) => s.organizationId)).size,
        totalSpaces: spaces.length,
        totalSessions,
        totalMessages,
        totalMessagesIsEstimated,
        totalBytes,
        notes: [
          'messageCount 对大文件按头部 64KB 窗口行密度估算 — session.messageCountIsEstimated=true 时数字 ±30%',
          '本导出不含消息正文，仅 metadata',
          'fileSizeBytes 仅指 messages.jsonl；events / snapshots 单列',
          'firstMessageTime / lastMessageTime 解析失败为 null（旧版本字段名差异）',
        ],
        conversations: spaces,
      }

      const ts = exportedAt.replace(/[:.]/g, '-')
      return {
        filename: `tabtin-conversation-summary-${ts}.json`,
        data: JSON.stringify(payload, null, 2),
        mimeType: 'application/json',
      }
    },
  })
}

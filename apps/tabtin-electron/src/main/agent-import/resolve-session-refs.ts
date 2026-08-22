/**
 * 将客户端 sessionRefs 收成「选择清单」，用主进程 scan 结果权威重解析。
 * 丢弃客户端 sourcePath，防止任意本机文件读（ 阻塞项 1）。
 */

import type { ImportScanResult, ImportSessionRef, ImportSourceId } from '@tabtin/cli-server-core'

export type SessionRefResolveFailure = {
  source: ImportSourceId
  sourceSessionId: string
  error: string
}

export type SessionRefResolveResult = {
  refs: ImportSessionRef[]
  failures: SessionRefResolveFailure[]
}

export function indexScanSessions(
  groupSource: ImportSourceId,
  scanned: ImportScanResult,
): Map<string, ImportSessionRef> {
  const byId = new Map<string, ImportSessionRef>()
  for (const w of scanned.workspaces) {
    for (const s of w.sessions) {
      if (s.source === groupSource) byId.set(s.sourceSessionId, s)
    }
  }
  for (const s of scanned.orphanSessions) {
    if (s.source === groupSource) byId.set(s.sourceSessionId, s)
  }
  return byId
}

/**
 * @param clientRefs 缺省 / 空 → 返回 scan 全量；否则只返回 scan 命中项。
 */
export function resolveAuthoritativeSessionRefs(args: {
  groupSource: ImportSourceId
  scanned: ImportScanResult
  clientRefs?: ImportSessionRef[] | null
}): SessionRefResolveResult {
  const { groupSource, scanned, clientRefs } = args
  const byId = indexScanSessions(groupSource, scanned)
  if (!clientRefs || clientRefs.length === 0) {
    return { refs: [...byId.values()], failures: [] }
  }

  const refs: ImportSessionRef[] = []
  const failures: SessionRefResolveFailure[] = []
  for (const clientRef of clientRefs) {
    const id = clientRef?.sourceSessionId
    if (!id || typeof id !== 'string') {
      failures.push({
        source: groupSource,
        sourceSessionId: String(id ?? ''),
        error: 'sessionRefs 缺少 sourceSessionId',
      })
      continue
    }
    if (clientRef.source && clientRef.source !== groupSource) {
      failures.push({
        source: groupSource,
        sourceSessionId: id,
        error: `sessionRef.source (${clientRef.source}) 与分组 source (${groupSource}) 不一致`,
      })
      continue
    }
    const auth = byId.get(id)
    if (!auth) {
      failures.push({
        source: groupSource,
        sourceSessionId: id,
        error: '会话不在主进程 scan 结果中（拒绝客户端伪造 sourcePath）',
      })
      continue
    }
    // 权威 ref 来自 scan；客户端 sourcePath 被自然丢弃
    refs.push(auth)
  }
  return { refs, failures }
}

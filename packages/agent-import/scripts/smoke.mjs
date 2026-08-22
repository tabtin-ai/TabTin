#!/usr/bin/env node
/**
 * 真实数据冒烟（本机只读）：detect 全家 → scan（近 30 天）→ 每家 parse 最新 2 条。
 * 用法：先 pnpm --filter @tabtin/agent-import build，再 node scripts/smoke.mjs [--all]
 * 输出对账数字；不写入任何源目录（writeAttachment 落系统临时目录）。
 */

import { detectAll, getAdapter, IMPORT_SOURCES, NodeImportIO } from '../dist/index.js'

const io = new NodeImportIO()
const since = process.argv.includes('--all')
  ? undefined
  : new Date(Date.now() - 30 * 86400 * 1000)

const t0 = Date.now()
console.log('== detect ==')
const detections = await detectAll(io)
for (const d of detections) {
  console.log(
    `${d.source.padEnd(12)} installed=${d.installed} sessions=${d.sessionCount} workspaces=${d.workspaceCount} newest=${d.newestActivityAt ?? '-'}${d.note ? ` note=${d.note}` : ''}`,
  )
}
console.log(`detect 耗时 ${Date.now() - t0}ms\n`)

for (const source of IMPORT_SOURCES) {
  const det = detections.find((d) => d.source === source)
  if (!det?.installed) continue
  const adapter = getAdapter(source)
  const t1 = Date.now()
  const scan = await adapter.scan(io, { since })
  const total = scan.workspaces.reduce((n, w) => n + w.sessions.length, 0) + scan.orphanSessions.length
  console.log(`== scan ${source}（${since ? '近30天' : '全量'}）: ${scan.workspaces.length} workspace / ${total} 会话 / 孤儿 ${scan.orphanSessions.length} · ${Date.now() - t1}ms`)

  const refs = [...scan.workspaces.flatMap((w) => w.sessions), ...scan.orphanSessions]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 2)
  for (const ref of refs) {
    const t2 = Date.now()
    try {
      const s = await adapter.parseSession(io, ref, { redact: true })
      const blocks = s.messages.reduce((n, m) => n + m.blocks.length, 0)
      const toolUses = s.messages.reduce((n, m) => n + m.blocks.filter((b) => b.type === 'tool_use').length, 0)
      const unknown = Object.entries(s.unknownRecords)
        .filter(([k]) => !k.startsWith('skipped:'))
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
      console.log(
        `  parse ${ref.sourceSessionId.slice(0, 8)}… layer=${s.layer} msgs=${s.messages.length} blocks=${blocks} tools=${toolUses} sub=${s.subagents.length} lossy=${s.lossy} title="${s.title.slice(0, 30)}" ${unknown ? `⚠${unknown}` : ''} · ${Date.now() - t2}ms`,
      )
    } catch (err) {
      console.log(`  parse ${ref.sourceSessionId.slice(0, 8)}… ❌ ${err?.message ?? err}`)
    }
  }
}
console.log(`\n总耗时 ${Date.now() - t0}ms`)

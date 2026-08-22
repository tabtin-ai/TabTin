/**
 * Electron renderer 端 TabDoc 数据流探针引导（dev-only）
 *
 * 与 tabtin-web 的 probeBootstrap 对称：
 * - 仅 import.meta.env.DEV 下启用；生产构建 enableDataflowProbe 不被调用 = 全程 no-op。
 * - sink：把事件同源 POST 到 renderer Vite dev server 的中间件 /__tabdoc_probe
 *   （见 electron.vite.config.ts::createTabDocProbeLogPlugin），由其追加写
 *   apps/tabtin_django/logs/tabdoc-dataflow.log（JSONL，与 Web 同一文件）。
 * - 不影响 `pnpm run dev` / `electron-vite dev`：纯附加。
 *
 * 验证用法（DevTools 控制台，origin=agent）：
 *   const sid = window.__tabdocProbe.sessionId()
 *   await window.__tabdocProbe.fireIntent('tabdoc.editAndSave', { markdown: '# probe\n验证' })
 *   window.__tabdocProbe.flush()
 *   // 然后：node scripts/verify-tabdoc-web.mjs --session <sid>
 * 不想读文件也可直接 window.__tabdocProbe.dump({ origin: 'agent' }) 在控制台看。
 */
import {
  enableDataflowProbe,
  setProbeSink,
  flushProbe,
  registerProbeIntent,
  type ProbeEvent,
} from '@tabtin/tabdoc-ui'
import { ensureSpaceSelectedOrThrow } from '@/services/spaceNavigation'
import { openResourceTabGuarded } from '@components/context-space/restore/openResourceMembershipGuard'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'

let started = false

export function bootstrapTabDocProbe(): void {
  if (started || !import.meta.env.DEV) return
  started = true

  enableDataflowProbe({ host: 'electron' })
  setProbeSink((batch: ProbeEvent[]) => {
    try {
      void fetch('/__tabdoc_probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        keepalive: true,
      })
    } catch {
      // dev-only 上送，失败不得影响业务；仍可用 window.__tabdocProbe.dump() 读内存
    }
  })

  // app 级意图：在「当前没有打开任何文档」时也能自助打开一篇文档，
  // 解除「必须先有人手动打开文档」这个唯一的人工前置，让无人值守的数据流验证 / 回归
  // 能从零自动跑通。编辑器级意图（tabdoc.edit / save / editAndSave）仍由 useDocEditor
  // 在文档挂载时注册——open 把文档挂起来，挂载后那几个意图随即可用。
  registerProbeIntent(
    'tabdoc.open',
    async (args) => {
      const docId = String((args?.docId ?? args?.documentId) ?? '').trim()
      const spaceId = String(args?.spaceId ?? '').trim()
      if (!docId) throw new Error('tabdoc.open 需要 docId（或 documentId）')
      if (!spaceId) throw new Error('tabdoc.open 需要 spaceId（可由 tabtin doc / space 元数据获取）')
      await ensureSpaceSelectedOrThrow(spaceId)
      openResourceTabGuarded(resolveForegroundTabScopeKey(spaceId), {
        type: 'tabdoc',
        id: docId,
        title: typeof args?.title === 'string' && args.title ? args.title : docId,
        meta: { spaceId },
      }, spaceId)
      return { docId, spaceId, opened: true }
    },
    '打开指定文档的 tab（应用级，参数 {docId, spaceId, title?}）；用于无人值守地先打开文档再驱动编辑',
  )

  window.addEventListener('beforeunload', () => flushProbe())
}

/**
 * Electron renderer 端 TabData 交互数据流探针引导（dev-only）
 *
 * 与 tabdoc/probeBootstrap.ts 同构：
 * - 仅 import.meta.env.DEV 下启用；生产构建 enableDataflowProbe 不被调用 = 全程 no-op。
 * - sink：把事件同源 POST 到 renderer Vite dev server 的中间件 /__tabdata_probe
 *   （见 electron.vite.config.ts::createTabDataProbeLogPlugin），由其追加写
 *   apps/tabtin_django/logs/tabdata-dataflow.log（JSONL）。
 * - 不影响 `pnpm run dev` / `electron-vite dev`：纯附加。
 *
 * 验证用法（DevTools 控制台，origin=agent）：
 *   const sid = window.__tabdataProbe.sessionId()
 *   await window.__tabdataProbe.fireIntent('tabdata.editCell',
 *     { recordId: '<rec>', field: '状态', value: '完成' })
 *   window.__tabdataProbe.flush()
 *   // 然后：node scripts/verify-tabdata-cell-edit.mjs --session <sid>
 * 不想读文件也可直接 window.__tabdataProbe.dump({ origin: 'agent' }) 在控制台看。
 *
 * 说明：app 级只注册 `tabdata.open`（自助打开一张表，解除「必须先手动打开表」的人工前置）；
 * 编辑器级意图 `tabdata.editCell` 由 DataGridAdapter 在表格挂载时注册（复用真实
 * handleCellValueChanged），open 把表挂起来后随即可用。
 */
import {
  enableDataflowProbe,
  setProbeSink,
  flushProbe,
  registerProbeIntent,
  type ProbeEvent,
} from '@tabtin/table-ui'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { ensureSpaceSelectedOrThrow } from '@/services/spaceNavigation'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'

let started = false

export function bootstrapTabDataProbe(): void {
  if (started || !import.meta.env.DEV) return
  started = true

  enableDataflowProbe({ host: 'electron' })
  setProbeSink((batch: ProbeEvent[]) => {
    try {
      void fetch('/__tabdata_probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        keepalive: true,
      })
    } catch {
      // dev-only 上送，失败不得影响业务；仍可用 window.__tabdataProbe.dump() 读内存
    }
  })

  registerProbeIntent(
    'tabdata.open',
    async (args) => {
      const tableId = String((args?.tableId ?? args?.id) ?? '').trim()
      const spaceId = String(args?.spaceId ?? '').trim()
      if (!tableId) throw new Error('tabdata.open 需要 tableId（或 id）')
      if (!spaceId) throw new Error('tabdata.open 需要 spaceId（可由 tabtin table / space 元数据获取）')
      await ensureSpaceSelectedOrThrow(spaceId)
      useSpaceContextTabsStore.getState().openResourceTab(resolveForegroundTabScopeKey(spaceId), {
        type: 'tabdata',
        id: tableId,
        title: typeof args?.title === 'string' && args.title ? args.title : tableId,
        meta: { spaceId },
      })
      return { tableId, spaceId, opened: true }
    },
    '打开指定表的 tab（应用级，参数 {tableId, spaceId, title?}）；用于无人值守地先打开表再驱动编辑',
  )

  window.addEventListener('beforeunload', () => flushProbe())
}

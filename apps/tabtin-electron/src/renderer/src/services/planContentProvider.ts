/**
 * planContentProvider — 客户端侧「打开 / 查看 plan」的读取 adapter
 *
 * 与 runtime 侧 PlanStore（写）对称：卡片「打开」不做 if-else 特判，按 `plan_ref`
 * + 是否遥控器分派：
 *   - document ref → TabDoc 编辑器标签页（全端可开）；
 *   - file ref + 本机 → 打开该 plan 文件**内容**（TabFiles 预览，走 ResourceRouter，
 *     与本地文件 artifact 同款 `tabtin://resource/file/<相对路径>` 通道）；
 *   - file ref + 遥控器 → 走现有 WS action 通道（/devices/query → fs.read_file_preview）
 *     确认最新内容可读（内容以卡片展开快照为主）。
 *
 * 说明：卡片展开区域已内联渲染 plan markdown 快照（全端可见），本 provider 负责
 * 「打开原文」的进一步动作；执行链路不经过此 provider。
 */

import { toast } from '@tabtin/smartsheet-ui'
import type { PlanRef } from '@tabtin/agent-wire'
import { parseResourcePointer } from '@tabtin/resource-router'
import { openResourceTabGuarded } from '@components/context-space/restore/openResourceMembershipGuard'
import { resourceRouter } from '@/services/resourceRouter'
import { remoteReadFilePreview } from '@components/context-space/folder/remote/remoteFsClient'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { createLogger } from '@/utils/logger'

const log = createLogger('planContentProvider')

interface OpenPlanArgs {
  ref: PlanRef
  spaceId: string | null
  /** 当前会话 id，用于 ResourceRouter 的 tabScopeKey 解析（file 载体打开内容用）。 */
  sessionId: string | null
  planName?: string
  /** 由调用方（卡片）用 useIsRemoteViewer 计算后传入。 */
  isRemoteViewer: boolean
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** 打开 / 查看 plan（按 ref 类型 + 是否遥控器分派）。 */
export async function openPlanRef({
  ref,
  spaceId,
  sessionId,
  planName,
  isRemoteViewer,
}: OpenPlanArgs): Promise<void> {
  // ── document 载体：TabDoc 编辑器 ──
  if (ref.kind === 'document') {
    if (!spaceId) {
      toast({ title: '无法定位 Space，暂不能打开 plan 文档。' })
      return
    }
    openResourceTabGuarded(resolveForegroundTabScopeKey(spaceId), {
      type: 'tabdoc',
      id: ref.document_id,
      title: planName || undefined,
      meta: { spaceId },
    }, spaceId)
    return
  }

  // ── file 载体 + 遥控器：WS 远程只读预览 ──
  if (isRemoteViewer) {
    if (!spaceId) {
      toast({ title: '无法定位 Space，暂不能读取远程 plan 文件。' })
      return
    }
    try {
      const preview = await remoteReadFilePreview(spaceId, ref.path)
      void preview // 内容已在卡片展开区呈现；此处确认文件仍可读。
      toast({
        title: '已读取远程 plan 文件最新内容',
        description: '预览见卡片展开区域（远程只读）。',
      })
    } catch (err) {
      log.warn('remote plan file preview failed', err)
      toast({
        title: 'plan 文件不可读',
        description: '可能已被回滚或删除。',
        variant: 'destructive',
      })
    }
    return
  }

  // ── file 载体 + 本机：打开文件内容（TabFiles 预览，走 ResourceRouter）──
  // 用卡片已可靠解析出的 spaceId **直接**调 resourceRouter.open（与 RichFile 本地文件
  // 点击同链路），不再经 tabScopeKey→session→space 间接解析（那条链在 block 渲染下可能
  // 解析空 spaceId 而静默 no-op）。
  if (!spaceId) {
    toast({ title: '无法定位 Space，暂不能打开 plan 文件。' })
    return
  }
  const params = new URLSearchParams({ hint: 'tabfiles' })
  params.set('title', planName || fileName(ref.path))
  const href = `tabtin://resource/file/${encodeURIComponent(ref.path)}?${params.toString()}`
  let pointer
  try {
    pointer = parseResourcePointer(href)
  } catch (err) {
    log.warn('parseResourcePointer failed for plan file', err)
    toast({ title: '无法解析 plan 文件路径。', variant: 'destructive' })
    return
  }
  void resourceRouter.open(spaceId, pointer, {
    triggerSource: 'window_open_fallback',
    ...(sessionId ? { tabScopeKey: `conversation:${sessionId}` } : {}),
  })
}

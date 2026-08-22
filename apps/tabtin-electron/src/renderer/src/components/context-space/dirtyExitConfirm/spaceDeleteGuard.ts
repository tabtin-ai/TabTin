/**
 * Space 删除前置守卫（W2.5 T9）
 *
 * 用法：在所有触发 useSpaceStore.deleteSpace 的 UI 入口前 await 本函数：
 * ```ts
 * const ok = await confirmDirtyBeforeSpaceDelete({ spaceId, spaceName })
 * if (!ok) return
 * await deleteSpace(spaceId)
 * ```
 *
 * 返回：
 * - true  → 用户确认（无 dirty 直接通过 / 用户选了"放弃" / 用户选了"全部保存"且全成功）
 * - false → 用户取消 / 保存中途失败（保护数据，不删 Space）
 *
 * **设计取舍**：本守卫**不**通过 packages/app-shell 的 bridge 实现，原因：
 * - WS 同步 / 多设备 push 的删除路径（use-space-store.ts:555）没有用户交互上下文，
 *   不能弹对话框
 * - 只有用户在本机主动删除时才需要确认，UI 入口拦截最自然
 *
 * **新增 UI 入口提醒**：未来如果新增了任何调 deleteSpace 的入口
 * （例如批量删除、右键菜单），**必须**先 await 本函数；
 * 否则删除前会绕过 dirty 保护。
 */
import { collectAllDirty } from '../dirtyRegistry'
import { requestDirtyExitConfirm } from './dirtyExitConfirmStore'
import { toast } from '@tabtin/smartsheet-ui'
import i18n from '@/i18n'

export interface ConfirmDirtyBeforeSpaceDeleteParams {
  spaceId: string
  spaceName?: string | null
}

export async function confirmDirtyBeforeSpaceDelete(
  params: ConfirmDirtyBeforeSpaceDeleteParams,
): Promise<boolean> {
  let dirty: ReturnType<typeof collectAllDirty>
  try {
    dirty = collectAllDirty(params.spaceId)
  } catch (err) {
    // P0-2 修复（产品视角 Review）：collectAllDirty 失败时**无法判断**是否有未保存改动，
    // 必须保守拦截删除（数据安全优先）。原版本 `return true` 等同于"出错就让用户删 Space"，
    // 与"有未保存风险则拦"承诺相反。
    console.error('[spaceDeleteGuard] collectAllDirty 失败，保守阻止删除:', err)
    toast({
      title: i18n.t('context:dirtyExitConfirm.collectFailedTitle', {
        defaultValue: '无法检查未保存内容',
      }),
      description: i18n.t('context:dirtyExitConfirm.collectFailedDesc', {
        defaultValue: '保护工作空间内可能存在的未保存改动，删除已被取消。请重启应用后重试。',
      }),
      variant: 'destructive',
    })
    return false
  }
  if (dirty.length === 0) return true

  const result = await requestDirtyExitConfirm({
    resources: dirty,
    reason: 'space-delete',
    spaceName: params.spaceName ?? null,
  })

  if (result.choice === 'cancel') return false
  if (result.choice === 'discard') return true

  // save-all：全成功 → true；任意失败 → toast + false（保留 Space）
  const failed = (result.saveResults ?? []).filter((r) => !r.ok)
  if (failed.length === 0) return true

  toast({
    title: i18n.t('context:dirtyExitConfirm.saveFailedToastTitle', {
      defaultValue: '部分文档保存失败',
    }),
    description: i18n.t('context:dirtyExitConfirm.saveFailedToastDesc', {
      defaultValue: '{{count}} 个文档未能保存到服务器。已保留这些标签，请检查网络后重试。',
      count: failed.length,
    }),
    variant: 'destructive',
  })
  return false
}

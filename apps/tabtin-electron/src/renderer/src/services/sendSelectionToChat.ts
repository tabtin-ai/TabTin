/**
 * sendSelectionToChat — TabData / TabDoc 选区「发送到对话」统一投递
 *
 * 对话模式（已有 activeScope）：注入当前 composer，不建新任务。
 * 工作台模式（无 activeScope）：按左上角「新任务」同源上下文进入草稿，
 * 把当前文件开到右侧应用栏，并把选区引用写入草稿 composer scope。
 *
 * 两个 scope 必须分开写：
 * - 引用 → `__draft__:{spaceId}`（composer）
 * - 文件 tab → `conversation:draft:{spaceId}`（右侧应用栏）
 *
 * 引用留在草稿 scope，不做 prefetch 落地提前 rehome。
 */

import i18n from '@/i18n'
import { toast } from '@tabtin/smartsheet-ui'
import { getDraftComposerPresetScopeId } from '@components/chat/composer-presets/scope'
import {
  openResourceTabGuarded,
  openTableTabGuarded,
} from '@components/context-space/restore/openResourceMembershipGuard'
import { expandCanvasForScope } from '@/services/openResourceLink'
import {
  navigateToNewTask,
  resolveNewTaskConversationTarget,
} from '@/services/newTaskDraftNavigation'
import {
  useContextInjectionStore,
  type ContextInjectPayload,
} from '@stores/useContextInjectionStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('SendSelectionToChat')

export type SelectionResourceKind = 'tabdata' | 'tabdoc'

export type SendSelectionToChatInput = {
  payload: ContextInjectPayload
  resource: {
    kind: SelectionResourceKind
    id: string
    title?: string
    /** 资源所属 Space；用于 membership refresh / meta */
    spaceId?: string | null
    meta?: Record<string, unknown>
  }
}

export type SendSelectionToChatResult =
  | { ok: true; mode: 'active-scope'; scopeId: string }
  | { ok: true; mode: 'new-task-draft'; spaceId: string; composerScopeId: string; tabScopeKey: string }
  | { ok: false; reason: 'missing-resource' | 'no-workspace' }

function focusComposerSoon(): void {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('[data-chat-input-textarea="true"]')?.focus()
  })
}

function openResourceInDraftScope(input: {
  tabScopeKey: string
  resource: SendSelectionToChatInput['resource']
}): void {
  const { tabScopeKey, resource } = input
  const refreshSpaceId = resource.spaceId ?? null
  const meta = {
    ...(resource.meta ?? {}),
    ...(refreshSpaceId ? { spaceId: refreshSpaceId } : {}),
  }

  if (resource.kind === 'tabdata') {
    openTableTabGuarded(tabScopeKey, resource.id, {
      meta,
      refreshSpaceId,
    })
  } else {
    openResourceTabGuarded(
      tabScopeKey,
      {
        type: 'tabdoc',
        id: resource.id,
        title: resource.title,
        meta,
      },
      refreshSpaceId,
    )
  }

  expandCanvasForScope(tabScopeKey)
}

/**
 * 投递选区到对话。成功时弹 toast；失败时弹 destructive toast。
 */
export function sendSelectionToChat(input: SendSelectionToChatInput): SendSelectionToChatResult {
  const resourceId = input.resource.id?.trim()
  if (!resourceId) {
    toast({
      title: i18n.t('tab.menu.addToChatFailedTitle', {
        ns: 'context',
        defaultValue: '无法加入对话',
      }),
      description: i18n.t('tab.menu.addToChatMissingResource', {
        ns: 'context',
        defaultValue: '当前资源不可用，请重新打开后再试',
      }),
      variant: 'destructive',
    })
    log.warn('send-selection skipped: missing resource id', {
      kind: input.resource.kind,
    })
    return { ok: false, reason: 'missing-resource' }
  }

  const injection = useContextInjectionStore.getState()
  const activeScopeId = injection.activeScopeId

  // 对话模式：有可注入的 composer，直接挂到当前对话
  if (activeScopeId) {
    injection.addInjectedPayloadToScope(activeScopeId, input.payload)
    toast({
      title: i18n.t('tab.menu.addToChatSuccess', {
        ns: 'context',
        defaultValue: '已加入对话',
      }),
      description: input.payload.label,
    })
    log.info('send-selection injected to active scope', {
      scopeId: activeScopeId,
      kind: input.resource.kind,
      resourceId,
    })
    return { ok: true, mode: 'active-scope', scopeId: activeScopeId }
  }

  // 工作台 / 无对话：进入与左上角「新任务」同源的草稿态
  const target = resolveNewTaskConversationTarget()
  if (!target.spaceId) {
    toast({
      title: i18n.t('tab.menu.addToChatNoWorkspaceTitle', {
        ns: 'context',
        defaultValue: '无法创建新任务',
      }),
      description: i18n.t('tab.menu.addToChatNoWorkspaceDesc', {
        ns: 'context',
        defaultValue: '找不到可用的工作空间，请先选择执行现场',
      }),
      variant: 'destructive',
    })
    log.warn('send-selection skipped: no new-task workspace', {
      kind: input.resource.kind,
      resourceId,
    })
    return { ok: false, reason: 'no-workspace' }
  }

  navigateToNewTask(target.spaceId, {
    isProjectNavActive: target.isProjectNavActive,
  })

  const composerScopeId = getDraftComposerPresetScopeId(target.spaceId)
  const tabScopeKey = `conversation:draft:${target.spaceId}`

  // resetNewTaskDraftUi 已清过草稿引用；此处写入本次选区，并设 activeScope 供后续叠加
  injection.addInjectedPayloadToScope(composerScopeId, input.payload)
  injection.setActiveScope(composerScopeId)

  openResourceInDraftScope({
    tabScopeKey,
    resource: { ...input.resource, id: resourceId },
  })

  focusComposerSoon()

  toast({
    title: i18n.t('tab.menu.addToChatNewTaskSuccess', {
      ns: 'context',
      defaultValue: '已创建新任务并加入引用',
    }),
    description: input.payload.label,
  })
  log.info('send-selection routed to new-task draft', {
    spaceId: target.spaceId,
    isProjectNavActive: target.isProjectNavActive,
    composerScopeId,
    tabScopeKey,
    kind: input.resource.kind,
    resourceId,
  })

  return {
    ok: true,
    mode: 'new-task-draft',
    spaceId: target.spaceId,
    composerScopeId,
    tabScopeKey,
  }
}

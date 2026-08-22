import type { ContextItem, ContextRegistry } from '@components/context-space/registry'
import { emitContextInject } from '@components/chat/context/useContextInjection'
import { useContextInjectionStore } from '@stores/useContextInjectionStore'
import { toast } from '@tabtin/smartsheet-ui'
import i18n from '@/i18n'

type ContextTranslator = (key: string, options?: { defaultValue?: string }) => string

function translate(key: string, defaultValue: string, t?: ContextTranslator): string {
  if (t) return t(key, { defaultValue })
  return i18n.t(key, { ns: 'context', defaultValue })
}

export function addContextItemToChat(
  item: ContextItem,
  registry: ContextRegistry,
  t?: ContextTranslator,
): boolean {
  const built = registry.buildContextAttachment(item)
  if (!built) {
    toast({
      title: translate('tab.menu.addToChatFailedTitle', '当前标签不支持加入对话', t),
      description: translate('tab.menu.addToChatFailedDesc', '请等待页面加载完成后再试', t),
      variant: 'destructive',
    })
    return false
  }

  const hasActiveScope = Boolean(useContextInjectionStore.getState().activeScopeId)
  if (!hasActiveScope) {
    toast({
      title: translate('tab.menu.addToChatNoChatTitle', '请先打开对话窗口', t),
      description: translate('tab.menu.addToChatNoChatDesc', '激活某个对话后再添加引用', t),
      variant: 'destructive',
    })
    return false
  }

  emitContextInject({
    type: built.refType,
    resourceId: built.resourceId,
    label: built.label,
    tabType: item.type as string,
    meta: built.meta,
  })
  toast({
    title: translate('tab.menu.addToChatSuccess', '已加入对话', t),
    description: built.label,
  })
  return true
}

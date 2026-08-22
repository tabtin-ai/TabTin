/**
 * 外部历史 → 特殊新对话展开：读本机档案后走 continueExternalArchiveChat。
 * 侧栏点档案行即走此路径，不再先进只读预览页。
 */

import { toast } from '@components/ui'
import { continueExternalArchiveChat } from './continueExternalArchiveChat'

let openingKey: string | null = null

export async function openExternalArchiveAsConversation(input: {
  organizationId: string
  source: string
  sourceSessionId: string
}): Promise<void> {
  const key = `${input.source}:${input.sourceSessionId}`
  if (openingKey === key) return
  openingKey = key
  try {
    const api = window.tabtin?.import
    if (!api?.getArchive) {
      toast({
        title: '无法打开',
        description: '当前客户端未暴露本机档案接口',
        variant: 'destructive',
      })
      return
    }
    const data = await api.getArchive({
      organizationId: input.organizationId,
      source: input.source,
      sourceSessionId: input.sourceSessionId,
    })
    if (!data?.meta) {
      toast({
        title: '无法打开',
        description: '未找到本机档案',
        variant: 'destructive',
      })
      return
    }
    await continueExternalArchiveChat({
      meta: data.meta as Parameters<typeof continueExternalArchiveChat>[0]['meta'],
      messages: (data.messages ?? []) as Parameters<typeof continueExternalArchiveChat>[0]['messages'],
      organizationId: input.organizationId,
    })
  } finally {
    openingKey = null
  }
}

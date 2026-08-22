import { createLogger } from '@/utils/logger'

const log = createLogger('CrawlViewError')

type CrawlViewErrorContext = {
  action: string
  message: string
  viewId?: string
  crawlspaceId?: string
  profile?: string
  partition?: string
  kind?: 'workspace-view' | 'normal-view'
  error?: unknown
  extra?: Record<string, any>
}

export function reportCrawlViewError(context: CrawlViewErrorContext): Error {
  const error =
    context.error instanceof Error
      ? context.error
      : context.error
        ? new Error(String(context.error))
        : new Error(context.message)

  log.error('crawl view error:', {
    action: context.action,
    message: context.message,
    viewId: context.viewId,
    crawlspaceId: context.crawlspaceId,
    profile: context.profile,
    partition: context.partition,
    kind: context.kind,
    error: error.message,
    extra: context.extra
  })

  return error
}

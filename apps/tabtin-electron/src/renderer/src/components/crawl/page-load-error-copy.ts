import {
  classifyPageLoadError,
  type PageLoadErrorKind,
} from '@shared/page-load-error-kind'

type Translate = (key: string) => string

const KNOWN: Exclude<PageLoadErrorKind, 'fallback'>[] = [
  'dns',
  'offline',
  'connection',
  'server',
]

export function resolvePageLoadErrorCopy(args: {
  errorDescription?: string | null
  errorCode?: number | null
  httpStatus?: number | null
  fallbackMessage?: string | null
  t: Translate
}): { title: string; message: string } {
  const kind = classifyPageLoadError({
    errorDescription: args.errorDescription,
    errorCode: args.errorCode,
    httpStatus: args.httpStatus,
  })

  if ((KNOWN as string[]).includes(kind)) {
    return {
      title: args.t(`workspace.pageLoadErrors.${kind}.title`),
      message: args.t(`workspace.pageLoadErrors.${kind}.hint`),
    }
  }

  return {
    title: args.t('workspace.pageLoadFailed'),
    message:
      args.fallbackMessage ||
      args.errorDescription ||
      args.t('workspace.pageLoadFailedDesc'),
  }
}

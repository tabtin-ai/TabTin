import { desktopCapturer, session, type Session, type Streams } from 'electron'
import { shouldAllowWebOpenExternal } from '../external-protocol-guard'

type DisplayMediaRequestHandler = NonNullable<Parameters<Session['setDisplayMediaRequestHandler']>[0]>
type DisplayMediaRequest = Parameters<DisplayMediaRequestHandler>[0]
type PermissionRequestHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
type PermissionRequestPermission = Parameters<PermissionRequestHandler>[1]
type PermissionRequestDetails = Parameters<PermissionRequestHandler>[3]
type PermissionCheckHandler = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>
type PermissionCheckPermission = Parameters<PermissionCheckHandler>[1]
type PermissionCheckDetails = Parameters<PermissionCheckHandler>[3]

export interface DisplayMediaLogger {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

export interface DesktopCapturerLike {
  getSources: typeof desktopCapturer.getSources
}

export interface DisplayMediaInstallOptions {
  targetSession?: Pick<
    Session,
    'setDisplayMediaRequestHandler' | 'setPermissionRequestHandler' | 'setPermissionCheckHandler'
  > | null
  desktopCapturerApi?: DesktopCapturerLike
  rendererUrl?: string
  trustedOrigins?: string[]
  isDev?: boolean
  captureMode?: 'current-tab' | 'main-display'
  allowScreenFallback?: boolean
  log?: DisplayMediaLogger
  platform?: NodeJS.Platform
}

const ALWAYS_ALLOW_PERMISSION_REQUESTS = new Set<PermissionRequestPermission>([
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'storage-access',
  'top-level-storage-access',
])

const ALWAYS_ALLOW_PERMISSION_CHECKS = new Set<PermissionCheckPermission>([
  'fullscreen',
  'pointerLock',
  'storage-access',
  'top-level-storage-access',
])

const resolveLogger = (log?: DisplayMediaLogger): Required<DisplayMediaLogger> => ({
  info: log?.info ?? (() => {}),
  warn: log?.warn ?? (() => {}),
  error: log?.error ?? (() => {}),
})

export function normalizeOrigin(candidate?: string | null): string | null {
  const value = candidate?.trim()
  if (!value) {
    return null
  }

  if (value === 'file://' || value.startsWith('file:')) {
    return 'file://'
  }
  if (value === 'tabtin-file://' || value.startsWith('tabtin-file:')) {
    return 'tabtin-file://'
  }

  try {
    const url = new URL(value)
    if (url.protocol === 'file:') {
      return 'file://'
    }
    if (url.protocol === 'tabtin-file:') {
      return 'tabtin-file://'
    }
    if (url.origin && url.origin !== 'null') {
      return url.origin
    }
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`
  } catch {
    return null
  }
}

const isLoopbackOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    )
  } catch {
    return false
  }
}

export function isTrustedDisplayMediaOrigin(
  origin: string | null | undefined,
  options: Pick<DisplayMediaInstallOptions, 'trustedOrigins' | 'rendererUrl' | 'isDev'> = {},
): boolean {
  const normalized = normalizeOrigin(origin)
  if (!normalized) {
    return false
  }

  if (normalized === 'file://' || normalized === 'tabtin-file://') {
    return true
  }

  const trusted = new Set(
    [options.rendererUrl, ...(options.trustedOrigins ?? [])]
      .map(item => normalizeOrigin(item))
      .filter((item): item is string => Boolean(item)),
  )

  if (trusted.has(normalized)) {
    return true
  }

  return options.isDev === true && isLoopbackOrigin(normalized)
}

export function resolvePermissionOrigin(args: {
  securityOrigin?: string | null
  requestingUrl?: string | null
  webContents?: { getURL?: () => string; isDestroyed?: () => boolean } | null
}): string | null {
  const direct = normalizeOrigin(args.securityOrigin) ?? normalizeOrigin(args.requestingUrl)
  if (direct) {
    return direct
  }

  if (args.webContents && args.webContents.isDestroyed?.() !== true) {
    return normalizeOrigin(args.webContents.getURL?.())
  }

  return null
}

export function shouldGrantPermissionRequest(args: {
  permission: PermissionRequestPermission
  details: PermissionRequestDetails
  webContents?: { getURL?: () => string; isDestroyed?: () => boolean } | null
  trustedOrigins?: string[]
  rendererUrl?: string
  isDev?: boolean
}): boolean {
  if (ALWAYS_ALLOW_PERMISSION_REQUESTS.has(args.permission)) {
    return true
  }

  // 网页唤起 bitbrowser: 等会走 openExternal；可信渲染源也不放行自定义协议
  if (args.permission === 'openExternal') {
    const externalURL =
      args.details && typeof args.details === 'object' && 'externalURL' in args.details
        ? (args.details as { externalURL?: string }).externalURL
        : undefined
    return shouldAllowWebOpenExternal(externalURL)
  }

  const origin = resolvePermissionOrigin({
    securityOrigin: 'securityOrigin' in args.details ? args.details.securityOrigin : undefined,
    requestingUrl: 'requestingUrl' in args.details ? args.details.requestingUrl : undefined,
    webContents: args.webContents,
  })

  return isTrustedDisplayMediaOrigin(origin, args)
}

export function shouldGrantPermissionCheck(args: {
  permission: PermissionCheckPermission
  requestingOrigin: string
  details: PermissionCheckDetails
  webContents?: { getURL?: () => string; isDestroyed?: () => boolean } | null
  trustedOrigins?: string[]
  rendererUrl?: string
  isDev?: boolean
}): boolean {
  if (ALWAYS_ALLOW_PERMISSION_CHECKS.has(args.permission)) {
    return true
  }

  if (args.permission === 'openExternal') {
    const externalURL =
      args.details && typeof args.details === 'object' && 'externalURL' in args.details
        ? (args.details as { externalURL?: string }).externalURL
        : undefined
    return shouldAllowWebOpenExternal(externalURL)
  }

  const origin = resolvePermissionOrigin({
    securityOrigin: args.requestingOrigin,
    requestingUrl: args.details.requestingUrl,
    webContents: args.webContents,
  })

  return isTrustedDisplayMediaOrigin(origin, args)
}

const pickPrimaryScreenSource = async (
  desktopCapturerApi: DesktopCapturerLike,
): Promise<Streams['video'] | undefined> => {
  const sources = await desktopCapturerApi.getSources({
    types: ['screen'],
    fetchWindowIcons: false,
    thumbnailSize: { width: 0, height: 0 },
  })

  const primary = sources.find(source => source.display_id) ?? sources[0]
  if (!primary) {
    return undefined
  }

  return {
    id: primary.id,
    name: primary.name,
  }
}

export async function resolveDisplayMediaStreams(
  request: DisplayMediaRequest,
  options: Pick<
    DisplayMediaInstallOptions,
    'captureMode' | 'allowScreenFallback' | 'desktopCapturerApi' | 'platform'
  > = {},
): Promise<Streams> {
  const captureMode = options.captureMode ?? 'current-tab'
  const streams: Streams = {}

  if (request.frame && captureMode === 'current-tab') {
    if (request.videoRequested) {
      streams.video = request.frame
    }
    if (request.audioRequested) {
      streams.audio = request.frame
      streams.enableLocalEcho = true
    }
    return streams
  }

  if (options.allowScreenFallback === false || !request.videoRequested) {
    if (request.audioRequested && request.frame) {
      streams.audio = request.frame
      streams.enableLocalEcho = true
    }
    return streams
  }

  const videoSource = await pickPrimaryScreenSource(options.desktopCapturerApi ?? desktopCapturer)
  if (videoSource) {
    streams.video = videoSource
  }

  if (request.audioRequested) {
    if ((options.platform ?? process.platform) === 'win32') {
      streams.audio = 'loopback'
    } else if (request.frame) {
      streams.audio = request.frame
      streams.enableLocalEcho = true
    }
  }

  return streams
}

export function installDisplayMediaHandlers(options: DisplayMediaInstallOptions = {}): void {
  const targetSession = options.targetSession ?? session.defaultSession
  if (!targetSession) {
    return
  }

  const log = resolveLogger(options.log)

  targetSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return shouldGrantPermissionCheck({
      permission,
      requestingOrigin,
      details,
      webContents,
      trustedOrigins: options.trustedOrigins,
      rendererUrl: options.rendererUrl,
      isDev: options.isDev,
    })
  })

  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const granted = shouldGrantPermissionRequest({
      permission,
      details,
      webContents,
      trustedOrigins: options.trustedOrigins,
      rendererUrl: options.rendererUrl,
      isDev: options.isDev,
    })

    if (permission === 'display-capture') {
      const origin = resolvePermissionOrigin({
        securityOrigin: 'securityOrigin' in details ? details.securityOrigin : undefined,
        requestingUrl: 'requestingUrl' in details ? details.requestingUrl : undefined,
        webContents,
      })
      if (!granted) {
        log.warn?.('[display-media] 拒绝 display-capture 权限请求:', origin ?? 'unknown')
      }
    }

    callback(granted)
  })

  targetSession.setDisplayMediaRequestHandler((request, callback) => {
    const trusted = isTrustedDisplayMediaOrigin(request.securityOrigin, {
      trustedOrigins: options.trustedOrigins,
      rendererUrl: options.rendererUrl,
      isDev: options.isDev,
    })

    if (!trusted) {
      log.warn?.('[display-media] 拒绝不受信任来源的媒体捕获:', request.securityOrigin)
      callback({})
      return
    }

    void resolveDisplayMediaStreams(request, {
      captureMode: options.captureMode,
      allowScreenFallback: options.allowScreenFallback,
      desktopCapturerApi: options.desktopCapturerApi,
      platform: options.platform,
    }).then((streams) => {
      if (!streams.video && !streams.audio) {
        log.warn?.('[display-media] 没有可授予的媒体流:', request.securityOrigin)
      }
      callback(streams)
    }).catch((error) => {
      log.error?.('[display-media] 处理媒体捕获请求失败:', error)
      callback({})
    })
  }, {
    useSystemPicker: false,
  })

  log.info?.('[display-media] 已安装 defaultSession 媒体捕获策略')
}

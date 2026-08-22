export type WebLayout = 'compact' | 'medium' | 'expanded'
export type WebInput = 'touch' | 'pointer' | 'hybrid'
export type WebOrientation = 'portrait' | 'landscape' | 'unknown'
export type MobileHostPlatform = 'ios' | 'android'
export type MobileHostFormFactor = 'phone' | 'tablet'

export interface MobileHostCapabilities {
  filePicker: boolean
  nativeFocus: boolean
  fullEditor: boolean
}

export interface MobileHostContext {
  version: 1
  platform: MobileHostPlatform
  formFactor: MobileHostFormFactor
  capabilities: MobileHostCapabilities
}

export interface WebPresentationEnvironment {
  layout: WebLayout
  input: WebInput
  orientation: WebOrientation
  mobileHost: MobileHostContext | null
}

export interface WebPresentationSignals {
  viewportWidth?: number
  viewportHeight?: number
  maxTouchPoints?: number
  coarsePointer?: boolean
  finePointer?: boolean
  mobileHost?: unknown
}

declare global {
  interface Window {
    __TABTIN_MOBILE_HOST__?: unknown
  }
}

export const MOBILE_HOST_CONTEXT_EVENT = 'tabtin:host-context'

const SERVER_ENVIRONMENT: WebPresentationEnvironment = {
  layout: 'expanded',
  input: 'pointer',
  orientation: 'unknown',
  mobileHost: null,
}

let cachedEnvironment = SERVER_ENVIRONMENT
let eventMobileHost: MobileHostContext | null = null
let hasEventMobileHostSnapshot = false

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseMobileHostContext(value: unknown): MobileHostContext | null {
  if (!isObject(value) || value.version !== 1) return null
  if (value.platform !== 'ios' && value.platform !== 'android') return null
  if (value.formFactor !== 'phone' && value.formFactor !== 'tablet') return null
  if (!isObject(value.capabilities)) return null

  const { filePicker, nativeFocus, fullEditor } = value.capabilities
  if (
    typeof filePicker !== 'boolean'
    || typeof nativeFocus !== 'boolean'
    || typeof fullEditor !== 'boolean'
  ) {
    return null
  }

  return {
    version: 1,
    platform: value.platform,
    formFactor: value.formFactor,
    capabilities: { filePicker, nativeFocus, fullEditor },
  }
}

export function resolveWebLayout(viewportWidth?: number): WebLayout {
  if (viewportWidth === undefined || !Number.isFinite(viewportWidth) || viewportWidth < 0) {
    return 'expanded'
  }
  if (viewportWidth < 600) return 'compact'
  if (viewportWidth < 1024) return 'medium'
  return 'expanded'
}

export function resolveWebInput(
  signals: Pick<WebPresentationSignals, 'maxTouchPoints' | 'coarsePointer' | 'finePointer'>,
): WebInput {
  const hasTouch = (signals.maxTouchPoints ?? 0) > 0 || signals.coarsePointer === true
  const hasFinePointer = signals.finePointer === true

  if (hasTouch && hasFinePointer) return 'hybrid'
  return hasTouch ? 'touch' : 'pointer'
}

export function resolveWebOrientation(
  viewportWidth?: number,
  viewportHeight?: number,
): WebOrientation {
  if (
    viewportWidth === undefined
    || viewportHeight === undefined
    || !Number.isFinite(viewportWidth)
    || !Number.isFinite(viewportHeight)
    || viewportWidth <= 0
    || viewportHeight <= 0
  ) {
    return 'unknown'
  }

  return viewportHeight >= viewportWidth ? 'portrait' : 'landscape'
}

export function resolveWebPresentationEnvironment(
  signals: WebPresentationSignals,
): WebPresentationEnvironment {
  return {
    layout: resolveWebLayout(signals.viewportWidth),
    input: resolveWebInput(signals),
    orientation: resolveWebOrientation(signals.viewportWidth, signals.viewportHeight),
    mobileHost: parseMobileHostContext(signals.mobileHost),
  }
}

export function isPhoneWebPresentation(
  presentation: Pick<WebPresentationEnvironment, 'layout' | 'mobileHost'>,
): boolean {
  return presentation.layout === 'compact' || presentation.mobileHost?.formFactor === 'phone'
}

export function isTabletWebPresentation(
  presentation: Pick<WebPresentationEnvironment, 'layout' | 'input' | 'mobileHost'>,
): boolean {
  if (presentation.mobileHost) {
    return presentation.mobileHost.formFactor === 'tablet'
  }

  return presentation.layout !== 'compact' && presentation.input === 'touch'
}

function readViewportWidth(): number | undefined {
  const layoutWidth = document.documentElement?.clientWidth
  if (typeof layoutWidth === 'number' && Number.isFinite(layoutWidth) && layoutWidth > 0) {
    return layoutWidth
  }

  const innerWidth = window.innerWidth
  return Number.isFinite(innerWidth) && innerWidth >= 0 ? innerWidth : undefined
}

function readViewportHeight(): number | undefined {
  const layoutHeight = document.documentElement?.clientHeight
  if (typeof layoutHeight === 'number' && Number.isFinite(layoutHeight) && layoutHeight > 0) {
    return layoutHeight
  }

  const innerHeight = window.innerHeight
  return Number.isFinite(innerHeight) && innerHeight >= 0 ? innerHeight : undefined
}

function readPointerMedia(query: string): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches
}

function readBrowserEnvironment(): WebPresentationEnvironment {
  const globalHost = parseMobileHostContext(window.__TABTIN_MOBILE_HOST__)
  return resolveWebPresentationEnvironment({
    viewportWidth: readViewportWidth(),
    viewportHeight: readViewportHeight(),
    maxTouchPoints: window.navigator?.maxTouchPoints,
    coarsePointer: readPointerMedia('(any-pointer: coarse)'),
    finePointer: readPointerMedia('(any-pointer: fine)'),
    mobileHost: hasEventMobileHostSnapshot ? eventMobileHost : globalHost,
  })
}

function hasSameHost(left: MobileHostContext | null, right: MobileHostContext | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  return left.version === right.version
    && left.platform === right.platform
    && left.formFactor === right.formFactor
    && left.capabilities.filePicker === right.capabilities.filePicker
    && left.capabilities.nativeFocus === right.capabilities.nativeFocus
    && left.capabilities.fullEditor === right.capabilities.fullEditor
}

function hasSameEnvironment(
  left: WebPresentationEnvironment,
  right: WebPresentationEnvironment,
): boolean {
  return left.layout === right.layout
    && left.input === right.input
    && left.orientation === right.orientation
    && hasSameHost(left.mobileHost, right.mobileHost)
}

export function getWebPresentationEnvironmentSnapshot(): WebPresentationEnvironment {
  if (typeof window === 'undefined') return SERVER_ENVIRONMENT

  const nextEnvironment = readBrowserEnvironment()
  if (!hasSameEnvironment(cachedEnvironment, nextEnvironment)) {
    cachedEnvironment = nextEnvironment
  }
  return cachedEnvironment
}

export function getServerWebPresentationEnvironmentSnapshot(): WebPresentationEnvironment {
  return SERVER_ENVIRONMENT
}

function addMediaQueryListener(mediaQuery: MediaQueryList, listener: () => void): () => void {
  mediaQuery.addEventListener('change', listener)
  return () => mediaQuery.removeEventListener('change', listener)
}

export function subscribeWebPresentationEnvironment(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined

  const coarsePointer = window.matchMedia?.('(any-pointer: coarse)')
  const finePointer = window.matchMedia?.('(any-pointer: fine)')
  const visualViewport = window.visualViewport
  const removeMediaListeners = [coarsePointer, finePointer]
    .filter((value): value is MediaQueryList => value !== undefined)
    .map((mediaQuery) => addMediaQueryListener(mediaQuery, onStoreChange))

  const handleHostContext = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail
    const parsedDetail = parseMobileHostContext(detail)
    // Treat each event as a complete snapshot. An unsupported future version must
    // clear the previous V1 value instead of silently reviving stale capabilities.
    eventMobileHost = parsedDetail
    hasEventMobileHostSnapshot = true
    onStoreChange()
  }

  window.addEventListener('resize', onStoreChange)
  visualViewport?.addEventListener('resize', onStoreChange)
  window.addEventListener(MOBILE_HOST_CONTEXT_EVENT, handleHostContext)

  return () => {
    window.removeEventListener('resize', onStoreChange)
    visualViewport?.removeEventListener('resize', onStoreChange)
    window.removeEventListener(MOBILE_HOST_CONTEXT_EVENT, handleHostContext)
    removeMediaListeners.forEach((removeListener) => removeListener())
  }
}

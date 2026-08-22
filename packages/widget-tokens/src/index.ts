/**
 * @tabtin/widget-tokens — single source of truth for TabTin widget design
 * tokens + sandbox iframe HTML wrapper.
 *
 * Imported from three places to keep widget visuals in lock-step with chat UI:
 *
 *   - `apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx`
 *     (chat preview srcDoc)
 *   - `apps/tabtin-electron/src/main/services/WidgetRenderService.ts`
 *     (Electron offscreen render via loadFile + capturePage)
 *   - `apps/tabtin-daemon/src/browser/DaemonBrowserService.ts.captureWidget`
 *     (Daemon offscreen render via page.setContent + page.screenshot)
 */

export {
  themeBundle,
  type ThemeBundle,
  LIGHT_TOKEN_BUNDLE,
  DARK_TOKEN_BUNDLE,
  LIGHT_TOKEN_KEYS,
  DARK_TOKEN_KEYS,
} from './theme-bundle.js'

export {
  WIDGET_CSP,
  WIDGET_LEGACY_COMPAT_TOKENS,
  DEFAULT_VIEWPORT,
  SEND_PROMPT_TEXT_MAX_LENGTH,
  SEND_PROMPT_META_MAX_BYTES,
  buildSendPromptBootstrap,
  buildWrapperStyle,
  buildResizeObserverBootstrap,
  buildPreviewScaleBootstrap,
  buildLightboxFitBootstrap,
  buildWrapper,
  type BuildWrapperOptions,
} from './wrapper.js'

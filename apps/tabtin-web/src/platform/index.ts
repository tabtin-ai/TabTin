import { createWebAuthAdapter } from './web-auth-adapter'

export const authAdapter = createWebAuthAdapter()

export { STORAGE_KEYS } from './web-auth-adapter'
export {
  hasNativeAuthHost,
  refreshAccessTokenFromNativeHost,
} from './native-auth-bridge'
export {
  NATIVE_FOCUS_REPORT_DEBOUNCE_MS,
  buildTabDataNativeFocusPayload,
  hasNativeFocusHost,
  reportNativeFocus,
  resolveTabDataNativeFocusReport,
} from './native-focus-bridge'
export type {
  NativeFocusAppType,
  NativeFocusPayload,
} from './native-focus-bridge'

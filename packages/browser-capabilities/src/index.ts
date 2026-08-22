/**
 * @tabtin/browser-capabilities
 *
 * Browser capabilities abstraction layer for TabTin
 * Based on Min Browser design
 */

// Core
export { ViewManager, getViewManager } from './core/ViewManager.js';
export type { UrlLoadGuard } from './core/ViewManager.js';
export type { ViewHost, GuestHandle, CreateGuestConfig } from './core/ViewHost.js';

// Types
export type { ViewState, CreateViewConfig } from './types/view.js';

// i18n
export { setBrowserCapabilitiesLocale, setBrowserCapabilitiesTranslator, t } from './i18n.js';

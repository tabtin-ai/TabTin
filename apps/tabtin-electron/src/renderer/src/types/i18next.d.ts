/**
 * i18next type augmentation for TabTin Electron.
 *
 * - returnNull: false → t() return type is string, never null
 * - defaultNS: 'common' → matches the runtime i18n configuration
 *
 * We intentionally do NOT declare resources here because:
 * 1. 29 namespaces with hundreds of nested, frequently-changing keys
 * 2. JSON resources can't use `as const` for full type inference
 * 3. Deep JSON types cause i18next's recursive key-builder to produce
 *    thousands of type computations, crashing the TS compiler
 * 4. Dynamic template keys like `card.ref_${type}` require string flexibility
 *
 * Trade-off: t() calls with interpolation options still need `defaultValue`
 * in the options object. This is a known i18next v24 behavior when resources
 * are not typed — the compiler ensures a fallback exists at compile time.
 */

import 'i18next'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    returnNull: false
  }
}

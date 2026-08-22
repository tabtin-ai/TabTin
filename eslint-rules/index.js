/**
 * TabTin ESLint 自定义规则 plugin barrel。
 *
 * 在 `eslint.config.mjs` 里：
 *   import tabtinPlugin from './eslint-rules/index.js'
 *   ...
 *   { plugins: { tabtin: tabtinPlugin },
 *     rules: { 'tabtin/no-empty-catch': 'error', ... } }
 */

import noEmptyCatch from './no-empty-catch.js'
import noDirectFetchInRenderer from './no-direct-fetch-in-renderer.js'
import noChatDesignViolations from './no-chat-design-violations.js'
import noDesignSystemViolations from './no-design-system-violations.js'
import useVirtualizerStableCallbacks from './use-virtualizer-stable-callbacks.js'
import preferScopedActivityEffects from './prefer-scoped-activity-effects.js'
import noApiPrefixInCliRoutes from './no-api-prefix-in-cli-routes.js'

export default {
  rules: {
    'no-empty-catch': noEmptyCatch,
    'no-direct-fetch-in-renderer': noDirectFetchInRenderer,
    'no-chat-design-violations': noChatDesignViolations,
    'no-design-system-violations': noDesignSystemViolations,
    'use-virtualizer-stable-callbacks': useVirtualizerStableCallbacks,
    'prefer-scoped-activity-effects': preferScopedActivityEffects,
    'no-api-prefix-in-cli-routes': noApiPrefixInCliRoutes,
  },
}

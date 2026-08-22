/**
 * Provider module — re-exports & factory.
 */

import type {
  LLMProvider,
} from '../engine/contracts/model-llm.js';
import { TabTinProxyProvider } from './proxy-provider.js';
import type { ProxyProviderConfig } from './proxy-provider.js';

export { TabTinProxyProvider } from './proxy-provider.js';
export type { ProxyProviderConfig } from './proxy-provider.js';
export {
  LocalCodexResponsesProvider,
  resolveReasoningEffort,
} from './local-codex-responses-provider.js';
export type {
  CodexAuthResolver,
  LocalCodexParamOverrides,
  LocalCodexResponsesProviderOptions,
} from './local-codex-responses-provider.js';

export function createProxyProvider(config: ProxyProviderConfig): LLMProvider {
  return new TabTinProxyProvider(config);
}

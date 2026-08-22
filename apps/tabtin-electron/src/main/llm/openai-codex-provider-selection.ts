import { isOpenAICodexModel } from './openai-codex-models.js';

/**
 * Codex 模型绕过平台代理，改由 Electron 主进程直连 ChatGPT Responses API。
 */
export function shouldUseLocalCodexProvider(modelId: string): boolean {
  return isOpenAICodexModel(modelId);
}

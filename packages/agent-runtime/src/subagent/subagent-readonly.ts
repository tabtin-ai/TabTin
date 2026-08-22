/**
 * Readonly sub-agent helpers — string-only prompt fallback + tool wrap.
 *
 * 含 `buildSystemPrompt` / ask-mode annotate 的产品逻辑已迁宿主
 * （ Stage 2b / Stage 4）。生产路径经 SystemPromptProvider +
 * EngineConfig.annotateReadonlyChildTools 注入。
 */

import type { ToolProvider } from '../engine/contracts/tools.js';
import type { Tool } from '../engine/contracts/tools.js';

/**
 * 无 SystemPromptProvider 时的字符串 fallback。
 * 只剥 subagent 编排段；不重写 `<agent_mode>`（产品文案由宿主 provider 负责）。
 */
export function resolveSubagentSystemPromptStringFallback(
  parentPrompt: string,
  _mode: string,
): string {
  let out = parentPrompt;
  out = out.replace(/<subagent_orchestration>[\s\S]*?<\/subagent_orchestration>/, '');
  out = out.replace(/<subagent_catalog>[\s\S]*?<\/subagent_catalog>/, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * readonly 子 Agent 工具标注。annotate 由宿主注入；缺省原样返回。
 */
export function wrapToolProviderForAskMode(
  base: ToolProvider,
  annotate?: (tools: Tool[]) => Tool[],
): ToolProvider {
  if (!annotate) return base;
  return {
    getTools: () => annotate(base.getTools()),
    refreshTools: base.refreshTools
      ? async () => {
          await base.refreshTools!();
        }
      : undefined,
  };
}

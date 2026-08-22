import {
  buildWorktreeRoutingSection,
  type WorkingDirType,
} from '@tabtin/agent-prompt'
import type { EngineHooks } from '@tabtin/agent-runtime/engine'
import { SYSTEM_SECTION_NAMES } from '@tabtin/agent-runtime/engine'

export interface WorktreeRoutingHookOptions {
  workingDirType?: WorkingDirType
}

/**
 * 将 TabTin 对话内的 worktree CLI 路由作为宿主策略注入 system prompt。
 * runtime 只负责通用 section 组装，不感知 worktree 语义。
 */
export function buildWorktreeRoutingHook(
  options: WorktreeRoutingHookOptions,
): EngineHooks {
  const enabled = options.workingDirType === 'code'
    || options.workingDirType === 'mixed'
  if (!enabled) return {}

  return {
    async beforeModel(ctx) {
      ctx.appendSystemSection(
        SYSTEM_SECTION_NAMES.cli_commands,
        buildWorktreeRoutingSection(),
        'worktree-routing',
        { placement: 'static' },
      )
    },
  }
}

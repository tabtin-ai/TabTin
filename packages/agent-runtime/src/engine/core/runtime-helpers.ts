/**
 * 主循环杂项共享 helper：注入文本抽取、skill 状态覆盖应用
 * （model/effort/allowedTools/activeSkill）、model_override 通知、runtime mode 解析。
 * 自 query.ts 抽出——被主循环、skill-slash、pressure-mode 多处共用。
 */
import type {
  SystemNoticeEvent,
} from '../contracts/wire-protocol.js';
import { RuntimeSystemNoticeEvent } from '../../event/events/observability-events.js';
import type {
  ContentBlock,
  Message,
  TextBlock,
} from '../contracts/conversation.js';
import type {
  RuntimeMode,
  ToolResult,
} from '../contracts/tools.js';
import type {
  EngineConfig,
  EngineState,
} from '../contracts/kernel.js';
import type { TokenEstimator } from '../context/token-budget.js';

export function extractInjectedText(msg: Message): string {
  return typeof msg.content === 'string'
    ? msg.content
    : (msg.content as ContentBlock[])
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
}


export function applySkillStateOverrides(
  state: EngineState,
  mod: NonNullable<ToolResult['contextModifier']>,
  tokenEstimator: TokenEstimator,
  activeSkillRef: { current: { skillKey: string; primaryEnv?: string } | null },
): string | null {
  let modelSwitched: string | null = null;
  if (mod.modelOverride) {
    state.model = mod.modelOverride;
    tokenEstimator.setModel(mod.modelOverride);
    modelSwitched = mod.modelOverride;
  }
  //  批次 10：`effortOverride` / `allowedTools` 的黑板写入删除——
  // 自 Wave 2a 起全库只写不读（预留信号从未接线）。contextModifier 字段
  // 本身保留（工具侧 API 面不变），真接线时走显式通道。
  //
  // Wave 1.5: Skill 运行时密钥注入——设置当前活动 Skill，下一轮 ReAct 构造
  // `ToolContext.skillContext` 时读取。清空语义：mod.activeSkill === null；
  // 未传字段（undefined）则保持上次值。
  if (mod.activeSkill !== undefined) {
    activeSkillRef.current = mod.activeSkill === null
      ? null
      : { skillKey: mod.activeSkill.skillKey, primaryEnv: mod.activeSkill.primaryEnv };
  }
  return modelSwitched;
}


export function buildModelOverrideNotice(model: string): SystemNoticeEvent {
  return new RuntimeSystemNoticeEvent({
      content: `Model switched to ${model} by skill`,
      notice_type: 'model_override',
      model,
      source: 'skill_invoke',
  }).toStreamEvent();
}

export function resolveRuntimeMode(runtimeMode: EngineConfig['runtimeMode']): RuntimeMode {
  return typeof runtimeMode === 'function'
    ? runtimeMode()
    : runtimeMode ?? 'interactive';
}

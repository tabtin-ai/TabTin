/**
 * 技能 slash 直链 hook：注入消息 → USER 事件、
 * contextModifier 状态覆盖应用（+ model_override 通知）、skill 执行、active-skill
 * → ToolContext.skillContext 构造。自 query.ts 抽出。
 */
import { UserEvent } from '../../event/events/user-events.js';
import { RuntimeSystemNoticeEvent } from '../../event/events/observability-events.js';
import { nextArrivalSeq } from '../../event/event-emitter.js';
import {
  extractInjectedText,
  applySkillStateOverrides,
  buildModelOverrideNotice,
} from '../core/runtime-helpers.js';
import type {
  StreamEvent,
  SystemNoticeEvent,
} from '../contracts/wire-protocol.js';
import type {
  Message,
} from '../contracts/conversation.js';
import type { ToolContext, ToolResult } from '../contracts/tools.js';
import { buildUserEventBlocks } from '../context/user-message.js';
import type {
  EngineHooks,
  EngineState,
  QueryParams,
  QueryDeps,
} from '../contracts/kernel.js';
import type { TokenEstimator } from '../context/token-budget.js';

export function* emitSkillInjectedUserEvents(
  messages: Message[],
  deps: QueryDeps,
): Generator<StreamEvent, void, undefined> {
  for (const msg of messages) {
    const textContent = extractInjectedText(msg);
    if (!textContent) continue;
    yield new UserEvent({
      client_event_id: deps.generateUUID(),
      content: textContent,
      source: 'skill_invoke',
      blocks_json: buildUserEventBlocks(textContent),
      arrival_seq: nextArrivalSeq(),
    }).toStreamEvent();
  }
}

export function* applySkillSlashContextModifier(args: {
  state: EngineState;
  contextModifier: NonNullable<ToolResult['contextModifier']>;
  tokenEstimator: TokenEstimator;
  activeSkillRef: { current: { skillKey: string; primaryEnv?: string } | null };
}): Generator<SystemNoticeEvent, void, undefined> {
  const modelSwitched = applySkillStateOverrides(
    args.state,
    args.contextModifier,
    args.tokenEstimator,
    args.activeSkillRef,
  );
  if (modelSwitched) yield buildModelOverrideNotice(modelSwitched);
}

export function buildSkillSlashNotice(content: string, noticeType: string): SystemNoticeEvent {
  return new RuntimeSystemNoticeEvent({
      content,
      notice_type: noticeType,
      source: 'skill_invoke',
  }).toStreamEvent();
}

function skillSlashErrorDisplayText(content: unknown, fallback: string): string {
  if (typeof content !== 'string' || !content.trim()) return fallback;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message;
  } catch {
    // 非 JSON 错误本身就是展示文案。
  }
  return content;
}

export function createSkillSlashHook(args: {
  request: QueryParams['skillSlashInvoke'];
  activation: ((input: { skill: string; args?: string; agentRunId?: string }) => Promise<ToolResult>) | undefined;
  refreshEnablement?: () => Promise<void>;
  deps: QueryDeps;
  tokenEstimator: TokenEstimator;
  activeSkillRef: { current: { skillKey: string; primaryEnv?: string } | null };
}): EngineHooks {
  return {
    async beforeRun(ctx): Promise<void> {
      const skillKey = args.request?.skillKey;
      if (!skillKey) return;
      await args.refreshEnablement?.();
      if (!args.activation) {
        ctx.emitEvent(buildSkillSlashNotice(
          `无法运行 Skill \`${skillKey}\`：当前会话未配置 Skill 激活器。`,
          'skill_slash_unavailable',
        ));
        return;
      }
      let result: ToolResult;
      try {
        result = await args.activation({
          skill: skillKey,
          args: args.request?.args,
          agentRunId: ctx.runId,
        });
      } catch (err) {
        result = { content: `运行 Skill \`${skillKey}\` 失败：${err instanceof Error ? err.message : String(err)}` };
      }
      if (result.newMessages?.length) {
        ctx.state.messages.push(...result.newMessages);
        for (const event of emitSkillInjectedUserEvents(result.newMessages, args.deps)) ctx.emitEvent(event);
        if (result.contextModifier) {
          for (const event of applySkillSlashContextModifier({
            state: ctx.state,
            contextModifier: result.contextModifier,
            tokenEstimator: args.tokenEstimator,
            activeSkillRef: args.activeSkillRef,
          })) ctx.emitEvent(event);
        }
        return;
      }
      const fallback = `无法运行 Skill \`${skillKey}\`。`;
      const content = skillSlashErrorDisplayText(result.content, fallback);
      ctx.emitEvent(buildSkillSlashNotice(content, 'skill_slash_error'));
    },
  };
}

export function buildToolSkillContext(
  activeSkill: { skillKey: string; primaryEnv?: string } | null,
): ToolContext['skillContext'] {
  if (!activeSkill) return undefined;
  return {
    skillKey: activeSkill.skillKey,
    primaryEnv: activeSkill.primaryEnv || undefined,
  };
}

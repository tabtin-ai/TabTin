/**
 * W3 / W7a 历史回归 —— SSoT 迁移后该测试文件直接测试
 * `@tabtin/agent-prompt::buildSystemPrompt` 的 customRules 行为，与 Daemon
 * 宿主行为保持一一对应。
 *
 * 「角色设定」persona 已下线——identity 段固定用系统默认身份，用户的身份/行为
 * 偏好统一写到 customRules。本文件锁定 "Daemon 调 SSoT 时 customRules 链路无
 * wrapper 漂移"。
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '@tabtin/agent-prompt';

describe('Daemon SSoT buildSystemPrompt – custom_rules (W3 / W7a)', () => {
  it('always renders the built-in default identity', () => {
    const out = buildSystemPrompt({ tools: [] });
    expect(out).not.toContain('你是 TabTin AI Agent');
    expect(out).toContain('## 运行环境');
    expect(out).toMatch(/<identity>/);
  });

  it('omits <custom_rules> when customRules is undefined', () => {
    const out = buildSystemPrompt({ tools: [] });
    expect(out).not.toContain('<custom_rules>');
  });

  it('omits <custom_rules> when customRules is whitespace-only', () => {
    const out = buildSystemPrompt({ tools: [], customRules: '   \n  ' });
    expect(out).not.toContain('<custom_rules>');
  });

  it('injects <custom_rules> directly after <identity>', () => {
    const rules = '- 禁用 emoji\n- 优先使用中文';
    const out = buildSystemPrompt({ tools: [], customRules: rules });
    // buildCustomRulesBlock 单层会加  优先级声明，不再是裸 wrap。
    expect(out).toContain('<custom_rules>');
    expect(out).toContain(rules);
    expect(out).toContain('</custom_rules>');
    const identityEnd = out.indexOf('</identity>');
    const rulesStart = out.indexOf('<custom_rules>');
    expect(identityEnd).toBeGreaterThan(-1);
    expect(rulesStart).toBeGreaterThan(identityEnd);
  });

  it('injects customRules alongside the default identity', () => {
    const out = buildSystemPrompt({
      tools: [],
      customRules: '只输出结构化 JSON',
    });
    expect(out).toContain('<identity>');
    expect(out).toContain('<custom_rules>');
    expect(out).toContain('只输出结构化 JSON');
    expect(out).toContain('</custom_rules>');
  });

  it('preserves baseline safety / planning sections (and execution for default agent mode)', () => {
    const out = buildSystemPrompt({ tools: [] });
    // execution 段仅在 agent mode（默认）出现；plan/ask/study 模式会被替换。
    expect(out).toContain('<execution>');
    expect(out).toContain('<safety>');
    expect(out).toContain('<planning>');
  });
});

import { describe, it, expect } from 'vitest';
import { buildCustomRulesBlock, buildCustomRulesSection } from '../sections.js';
import { buildSystemPrompt } from '../builder.js';

/**
 * 设置 IA Phase 3 §8.6 分层规则（个人通用 + Agent 专属）—— buildCustomRulesBlock
 * 纯函数 + buildSystemPrompt 集成。
 *
 * 关键验收：拼接顺序（个人在前、Agent 在后）、段首优先级声明、逐条分类合并协议、
 * 两层子标题（空层跳过）、空语义、**向后兼容**（仅 Agent 专属层 → 今天的单段
 * 形态不变）、DEFAULT_BEHAVIOR_RULES 关系（系统默认低于自定义规则，安全边界不可覆盖）。
 *
 * （原「团队基线」层已下线：团队级一刀切 prompt 难适配不同岗位，岗位差异化改由
 * skill 系统按需装载承担。本测试钉死「团队子标题永不出现」。）
 */
describe('buildCustomRulesBlock — 分层规则纯函数', () => {
  // ── 空语义 ──────────────────────────────────────────────────────
  it('两层全空 → 返回空串', () => {
    expect(buildCustomRulesBlock({})).toBe('');
    expect(
      buildCustomRulesBlock({ personalRules: '   ', customRules: '\n\t' }),
    ).toBe('');
  });

  // ── 仅 Agent 专属层（个人空）→ 单段 + 段首优先级声明────
  it('仅 customRules（个人空）→ 单段 + 段首优先级声明覆盖 principle 默认', () => {
    const out = buildCustomRulesBlock({ customRules: '只用中文回复' });
    expect(out).toContain('<custom_rules>');
    expect(out).toContain('</custom_rules>');
    expect(out).toContain('只用中文回复');
    //  / ：单层也注入优先级声明（含本轮临时偏好与硬边界）
    expect(out).toContain('本轮用户明确临时要求（偏好范围）');
    expect(out).toContain('本段自定义规则');
    // 点名覆盖 <principle> 的「跟随用户语言」默认（issue 的语言冲突场景）
    expect(out).toContain('<principle>');
    expect(out).toContain('跟随用户语言');
    // 安全边界不可覆盖
    expect(out).toContain('平台安全、权限、数据保护、审批与 sandbox');
    expect(out).toContain('硬边界');
    // 单层不含多层专属的合并链 / 子标题
    expect(out).not.toContain('Agent 专属偏好 > 个人通用偏好 > `<principle>` 系统默认行为');
    expect(out).not.toContain('## Agent 专属规则');
    expect(out).not.toContain('## 个人通用规则');
    // 与裸 wrap buildCustomRulesSection 不再字节一致（单层现在带声明，裸 wrap 不变）
    expect(out).not.toBe(buildCustomRulesSection('只用中文回复'));
  });

  it('仅 customRules 带首尾空白 → trim 后单段 + 声明', () => {
    const out = buildCustomRulesBlock({ customRules: '  规则  ' });
    expect(out).toContain('本轮用户明确临时要求（偏好范围）');
    expect(out).toContain('\n规则\n');
    expect(out).not.toContain('\n  规则  \n');
  });

  // ──  回归：单层语言类规则覆盖 principle「跟随用户语言」默认 ──
  it('#2947：单层语言规则 + principle 默认 → prompt 声明自定义规则覆盖语言默认', () => {
    const result = buildSystemPrompt({
      tools: [],
      customRules: '全程用英文回复，语气礼貌且带夸张情绪。',
    });
    // principle 段带「跟随用户语言」默认
    expect(result).toContain('跟随用户语言');
    // custom_rules 段带优先级声明，点名覆盖 principle 默认
    const customIdx = result.indexOf('<custom_rules>');
    const customSlice = result.slice(
      customIdx,
      result.indexOf('</custom_rules>', customIdx) + '</custom_rules>'.length,
    );
    expect(customSlice).toContain('本轮用户明确临时要求（偏好范围）');
    expect(customSlice).toContain('跟随用户语言');
    expect(customSlice).toContain('全程用英文回复');
  });

  // ── 多层：段首声明 + 子标题 ──────────────────────────────────────
  it('个人 + Agent → 段首优先级声明 + 个人/Agent 子标题', () => {
    const out = buildCustomRulesBlock({ personalRules: '请用中文', customRules: '输出 JSON' });
    expect(out).toContain('<custom_rules>');
    expect(out).toContain('</custom_rules>');
    expect(out).toContain(
      '平台硬边界 > 本轮用户明确临时要求（偏好范围）> Agent 专属偏好 > 个人通用偏好 > `<principle>` 系统默认行为',
    );
    expect(out).toContain('## 个人通用规则');
    expect(out).toContain('请用中文');
    expect(out).toContain('## Agent 专属规则');
    expect(out).toContain('输出 JSON');
    // 团队层已下线 —— 永不出现团队子标题
    expect(out).not.toContain('## 团队规则');
  });

  it('两层都有 → 子标题与内容顺序 个人 < Agent', () => {
    const out = buildCustomRulesBlock({
      personalRules: 'P-RULE',
      customRules: 'A-RULE',
    });
    const pIdx = out.indexOf('## 个人通用规则');
    const aIdx = out.indexOf('## Agent 专属规则');
    expect(pIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeGreaterThan(pIdx);
    expect(out.indexOf('P-RULE')).toBeLessThan(out.indexOf('A-RULE'));
  });

  it('仅 personalRules → 含个人子标题、不含 Agent；指向 agent-profile', () => {
    const out = buildCustomRulesBlock({ personalRules: '个人统一用中文' });
    expect(out).toContain('## 个人通用规则');
    expect(out).toContain('个人统一用中文');
    expect(out).toContain('agent-profile');
    expect(out).toContain('人设与规则');
    expect(out).not.toContain('## Agent 专属规则');
    expect(out).not.toContain('## 团队规则');
  });

  it('空白层（纯空白）按空处理、走仅个人分支', () => {
    const out = buildCustomRulesBlock({ personalRules: 'P', customRules: '   \n ' });
    expect(out).toContain('## 个人通用规则');
    expect(out).toContain('agent-profile');
    expect(out).not.toContain('## Agent 专属规则');
  });

  // ── DEFAULT_BEHAVIOR_RULES 关系（不强删，段首点明优先级）──────────
  it('仅个人段首点明可被 agent-profile / 本轮临时偏好覆盖、且高于 principle 默认', () => {
    const out = buildCustomRulesBlock({ personalRules: '请始终用中文' });
    expect(out).toContain('系统默认行为');
    expect(out).toContain('<principle>'); // 指向内置规则所在段
    expect(out).toContain('Agent 专属偏好');
    expect(out).toContain('本轮用户明确临时要求（偏好范围）');
  });

  it('段首要求先分类，再逐条决定覆盖还是叠加', () => {
    const out = buildCustomRulesBlock({
      personalRules: '全部使用中文回复。先给结论。',
      customRules: '全部使用英文回复。',
    });
    expect(out).toContain('按约束对象 / 意图分类');
    expect(out).toContain('同类别、同约束对象且');
    expect(out).toContain('只执行 Agent 专属规则');
    expect(out).toContain('叠加执行');
    expect(out).toContain('不要试图同时满足两者');
    expect(out).toContain('本轮用户明确临时要求（偏好范围）');
  });

  it('段首明确安全、权限和审批边界不能被自定义规则覆盖', () => {
    const out = buildCustomRulesBlock({ personalRules: 'X' });
    expect(out).toContain('平台安全、权限、数据保护、审批与 sandbox');
    expect(out).toContain('硬边界不可被');
  });
});

describe('buildSystemPrompt — 分层规则集成', () => {
  it('personalRules / customRules 透传并按个人通用、Agent 专属展示顺序渲染', () => {
    const result = buildSystemPrompt({
      tools: [],
      personalRules: 'PERSONAL-X',
      customRules: 'AGENT-Z',
    });
    expect(result).toContain('<custom_rules>');
    expect(result.indexOf('PERSONAL-X')).toBeLessThan(result.indexOf('AGENT-Z'));
  });

  it('仅 personalRules（无 customRules）也注入 custom_rules 块', () => {
    const result = buildSystemPrompt({ tools: [], personalRules: '请用中文' });
    expect(result).toContain('<custom_rules>');
    expect(result).toContain('请用中文');
  });

  it('个人空 + 仅 customRules → 单段 + 段首优先级声明（无分层合并链）', () => {
    const result = buildSystemPrompt({ tools: [], customRules: 'ONLY-AGENT' });
    expect(result).toContain('<custom_rules>');
    expect(result).toContain('ONLY-AGENT');
    //  / ：单层也带优先级声明
    expect(result).toContain('本轮用户明确临时要求（偏好范围）');
    expect(result).toContain('本段自定义规则');
    // 单层不含多层专属合并链 / 子标题
    expect(result).not.toContain(
      'Agent 专属偏好 > 个人通用偏好 > `<principle>` 系统默认行为',
    );
    expect(result).not.toContain('## Agent 专属规则');
  });

  it('两层全空 → 无 custom_rules 段', () => {
    const result = buildSystemPrompt({ tools: [] });
    expect(result).not.toContain('<custom_rules>');
  });

  it('user_portrait 位于分层块之后、模式特殊段之前', () => {
    const result = buildSystemPrompt({
      tools: [],
      userPortrait: '## 工作背景\nX',
      personalRules: '请用中文',
    });
    const portraitIdx = result.indexOf('<user_portrait>');
    const customIdx = result.indexOf('<custom_rules>');
    const executionIdx = result.indexOf('<execution>');
    expect(portraitIdx).toBeGreaterThanOrEqual(0);
    expect(portraitIdx).toBeGreaterThan(customIdx);
    expect(executionIdx).toBeGreaterThan(portraitIdx);
  });
});

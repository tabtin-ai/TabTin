import { describe, it, expect } from 'vitest';
import {
  checkPresenceInvariants,
  detectLanguage,
  checkSectionCharBudget,
  checkLanguageDiscipline,
  checkCacheDiscipline,
  checkToolHardContract,
  checkNoDeprecatedTerms,
  DEPRECATED_PARAM_TERMS,
  collectInputSchemaFieldDescriptions,
  isHighRiskKeyField,
  getFieldBudget,
  checkFieldCharBudget,
  checkFieldLanguageDiscipline,
} from '../audit-helpers.js';
import type { SectionDescriptor } from '../section-descriptor.js';

function makeDescriptor(overrides: Partial<SectionDescriptor> = {}): SectionDescriptor {
  return {
    id: 'test_section',
    category: 'base_prompt_section',
    source: '@tabtin/agent-prompt',
    language: 'zh',
    charBudget: 1000,
    cacheBreak: false,
    injectionTiming: 'runtime-create',
    role: 'system',
    position: 'head',
    description: '测试段',
    writerLocations: ['test.ts:1'],
    renderCondition: {
      modes: ['agent', 'plan', 'ask', 'study', 'group'],
      hosts: { electron: true, daemon: true },
    },
    presenceInProduction: {
      observed: true,
      totalSessions: 38,
      category: 'active',
    },
    ...overrides,
  };
}

describe('checkPresenceInvariants', () => {
  it('active + observed=true + hitSessions 缺省 → ok', () => {
    const d = makeDescriptor();
    expect(checkPresenceInvariants(d).ok).toBe(true);
  });

  it('active + observed=true + hitSessions=5 → ok', () => {
    const d = makeDescriptor({
      presenceInProduction: { observed: true, hitSessions: 5, totalSessions: 38, category: 'active' },
    });
    expect(checkPresenceInvariants(d).ok).toBe(true);
  });

  it('active + observed=false → 拦截', () => {
    const d = makeDescriptor({
      presenceInProduction: { observed: false, totalSessions: 38, category: 'active' },
    });
    const r = checkPresenceInvariants(d);
    expect(r.ok).toBe(false);
    expect(r.issues.some((s) => s.includes('observed=true'))).toBe(true);
  });

  it('active + hitSessions=0 → 拦截（应该缺省 或 >=1）', () => {
    const d = makeDescriptor({
      presenceInProduction: { observed: true, hitSessions: 0, totalSessions: 38, category: 'active' },
    });
    const r = checkPresenceInvariants(d);
    expect(r.ok).toBe(false);
    expect(r.issues.some((s) => s.includes('hitSessions >= 1'))).toBe(true);
  });

  it('hitSessions=-1 → 拦截（sentinel 禁用）', () => {
    const d = makeDescriptor({
      presenceInProduction: { observed: true, hitSessions: -1, totalSessions: 38, category: 'active' },
    });
    const r = checkPresenceInvariants(d);
    expect(r.ok).toBe(false);
    expect(r.issues.some((s) => s.includes('-1 sentinel forbidden'))).toBe(true);
  });

  it('hitSessions=非整数（字符串） → 拦截', () => {
    const d = makeDescriptor({
      presenceInProduction: {
        observed: true,
        // @ts-expect-error 故意传错类型测 audit
        hitSessions: 'one',
        totalSessions: 38,
        category: 'active',
      },
    });
    const r = checkPresenceInvariants(d);
    expect(r.ok).toBe(false);
    expect(r.issues.some((s) => s.includes('must be integer'))).toBe(true);
  });

  it('hitSessions=小数 → 拦截', () => {
    const d = makeDescriptor({
      presenceInProduction: { observed: true, hitSessions: 1.5, totalSessions: 38, category: 'active' },
    });
    const r = checkPresenceInvariants(d);
    expect(r.ok).toBe(false);
    expect(r.issues.some((s) => s.includes('must be integer'))).toBe(true);
  });

  it('cold + observed=false + hitSessions=0 → ok', () => {
    const d = makeDescriptor({
      presenceInProduction: { observed: false, hitSessions: 0, totalSessions: 38, category: 'production-cold' },
    });
    expect(checkPresenceInvariants(d).ok).toBe(true);
  });

  it('cold + observed=true → 拦截', () => {
    const d = makeDescriptor({
      presenceInProduction: { observed: true, hitSessions: 0, totalSessions: 38, category: 'production-cold' },
    });
    const r = checkPresenceInvariants(d);
    expect(r.ok).toBe(false);
    expect(r.issues.some((s) => s.includes('observed=false'))).toBe(true);
  });

  it('cold + hitSessions=1 → 拦截（cold 必须严格 0）', () => {
    const d = makeDescriptor({
      presenceInProduction: { observed: false, hitSessions: 1, totalSessions: 38, category: 'production-cold' },
    });
    const r = checkPresenceInvariants(d);
    expect(r.ok).toBe(false);
    expect(r.issues.some((s) => s.includes('hitSessions=0 strict'))).toBe(true);
  });

  it('cold + hitSessions 缺省 → 拦截（cold 必须显式 0）', () => {
    const d = makeDescriptor({
      presenceInProduction: { observed: false, totalSessions: 38, category: 'production-cold' },
    });
    const r = checkPresenceInvariants(d);
    expect(r.ok).toBe(false);
    expect(r.issues.some((s) => s.includes('hitSessions=0 strict'))).toBe(true);
  });
});

describe('detectLanguage', () => {
  it('纯中文段 → zh', () => {
    expect(detectLanguage('你是 TabTin AI Agent，运行环境是用户本地。')).toBe('zh');
  });

  it('纯英文段 → en', () => {
    expect(
      detectLanguage(
        'You are a conversation summarizer. Create a detailed structured summary preserving essential information.',
      ),
    ).toBe('en');
  });

  it('中文段含 XML tag 和工具名 → 不被误判为 mixed', () => {
    const text =
      '## 行为规则\n\n你必须按 `<ask_user_tools_usage>` 段使用 ask_user 工具，调用 `tabtin commands --format json` 发现命令。';
    expect(detectLanguage(text)).toBe('zh');
  });

  it('中文段含路径 / errno / 缩写 → 不被误判', () => {
    const text =
      'archive 在 /Users/foo/Library/Application Support/TabTin 下，遇到 EACCES 错误时调用 JSON API 返回 UTF-8 数据。';
    expect(detectLanguage(text)).toBe('zh');
  });

  it('英文段含中文工具名引用 → 仍判 en', () => {
    const text =
      'You MUST call the conversation summarizer. The output should preserve every concrete fact, decision, file path, and code snippet from prior turns. Do NOT call any tools.';
    expect(detectLanguage(text)).toBe('en');
  });

  it('中英真混杂 (10-50% CJK) → mixed', () => {
    // CJK 约 22%（11/51）落在 10%-50% 区间
    const text =
      '用户必须先 read the file then write content here properly，否则 will fail 整个操作。';
    expect(detectLanguage(text)).toBe('mixed');
  });

  it('少量中文动词混入英文段 (CJK < 10%) → en (主体语言归宿)', () => {
    // CJK 只占 5%，按算法判 en——audit 想抓的是 10-50% 混杂，这种"英文为主+少量中文连接词"算英文
    const text =
      '注意 the workspace is shared between agents 所以 don\'t forget to lock the file before write 否则 will overwrite each other 的修改 leading to data loss.';
    expect(detectLanguage(text)).toBe('en');
  });

  it('纯 marker / 短引用无可判字符 → 默认 zh', () => {
    expect(detectLanguage('<context>')).toBe('zh');
    expect(detectLanguage('```\n```')).toBe('zh');
  });

  it('全代码块剥离后 → zh 默认', () => {
    expect(detectLanguage('`code` and `more_code` plus ALL_CAPS')).toBe('zh');
  });
});

describe('checkSectionCharBudget', () => {
  it('实际长度 <= budget → ok', () => {
    const d = makeDescriptor({ charBudget: 100 });
    const r = checkSectionCharBudget(d, 'a'.repeat(50));
    expect(r.ok).toBe(true);
    expect(r.actual).toBe(50);
    expect(r.budget).toBe(100);
  });

  it('实际长度 > budget → 拦截', () => {
    const d = makeDescriptor({ charBudget: 100 });
    const r = checkSectionCharBudget(d, 'a'.repeat(150));
    expect(r.ok).toBe(false);
    expect(r.actual).toBe(150);
  });

  it('实际长度 == budget → ok（边界）', () => {
    const d = makeDescriptor({ charBudget: 100 });
    const r = checkSectionCharBudget(d, 'a'.repeat(100));
    expect(r.ok).toBe(true);
  });
});

describe('checkLanguageDiscipline', () => {
  it('declared=zh + detected=zh → ok', () => {
    const d = makeDescriptor({ language: 'zh' });
    const r = checkLanguageDiscipline(d, '你必须按规则执行任务，不要随意调用工具。');
    expect(r.ok).toBe(true);
  });

  it('declared=zh + detected=en → 拦截', () => {
    const d = makeDescriptor({ language: 'zh' });
    const r = checkLanguageDiscipline(
      d,
      'You must follow the rules strictly and do not call any tool randomly.',
    );
    expect(r.ok).toBe(false);
    expect(r.detected).toBe('en');
  });

  it('declared=en + 有 exception reason → ok', () => {
    const d = makeDescriptor({
      language: 'en',
      languageExceptionReason: 'compact 链路弱模型对中文 system 遵从度低',
    });
    const r = checkLanguageDiscipline(d, 'You are a conversation summarizer producing structured output.');
    expect(r.ok).toBe(true);
    expect(r.hasException).toBe(true);
  });

  it('declared=en + 缺 exception reason → 拦截（review #2 加强）', () => {
    const d = makeDescriptor({
      language: 'en',
      // 故意不填 languageExceptionReason
    });
    const r = checkLanguageDiscipline(d, 'You are a conversation summarizer producing structured output.');
    expect(r.ok).toBe(false);
    expect(r.hasException).toBe(false);
    expect(r.reason).toContain('language=en requires languageExceptionReason');
  });

  it('declared=en + 缺 reason + detected 也是 zh（双违规） → 拦截，reason 同时含两条', () => {
    const d = makeDescriptor({
      language: 'en',
      // 缺 exception reason
    });
    const r = checkLanguageDiscipline(d, '你必须按规则执行任务，不要随意调用工具。');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('declared language=en but detected=zh');
    expect(r.reason).toContain('language=en requires languageExceptionReason');
  });
});

describe('checkCacheDiscipline', () => {
  it('cacheBreak=true + reason → ok', () => {
    const d = makeDescriptor({ cacheBreak: true, cacheBreakReason: '每轮 datetime 变化' });
    expect(checkCacheDiscipline(d).ok).toBe(true);
  });

  it('cacheBreak=true + 缺 reason → 拦截', () => {
    const d = makeDescriptor({ cacheBreak: true });
    const r = checkCacheDiscipline(d);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toContain('cacheBreakReason');
  });

  it('cacheBreak=false → 不要求 reason', () => {
    const d = makeDescriptor({ cacheBreak: false });
    expect(checkCacheDiscipline(d).ok).toBe(true);
  });
});

describe('checkToolHardContract (P7 主题分组)', () => {
  it('non-tool_description → 不适用', () => {
    const d = makeDescriptor({ category: 'base_prompt_section' });
    const r = checkToolHardContract(d, 'whatever');
    expect(r.applicable).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.missingTopics).toEqual([]);
  });

  it('low-risk tool → 不适用', () => {
    const d = makeDescriptor({ category: 'tool_description', id: 'ask_user_tool', tier: 'low-risk' });
    const r = checkToolHardContract(d, 'short description');
    expect(r.applicable).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('high-risk 未登记 → applicable=false（由 audit test 单独抓未登记）', () => {
    const d = makeDescriptor({
      category: 'tool_description',
      id: 'unknown_high_risk_tool',
      tier: 'high-risk',
    });
    const r = checkToolHardContract(d, '内容');
    expect(r.applicable).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('high-risk read_file 缺所有主题 → 报全部 missingTopics', () => {
    const d = makeDescriptor({
      category: 'tool_description',
      id: 'read_file_tool',
      tier: 'high-risk',
    });
    const r = checkToolHardContract(d, '读文件，按行返回内容');
    expect(r.applicable).toBe(true);
    expect(r.ok).toBe(false);
    const missingNames = r.missingTopics.map((t) => t.name);
    expect(missingNames).toContain('失败处理硬契约');
    expect(missingNames).toContain('分页 + 续读信号');
    expect(missingNames).toContain('行号前缀剥离 (edit_file 衔接)');
    // 阶段 6 review 补的两条硬契约 audit 也要抓
    expect(missingNames).toContain('单行截断不重试');
    expect(missingNames).toContain('图片 resize 不重读');
  });

  it('high-risk read_file 主题 OR 同义词：失败处理用 envelope 同义词 → ok', () => {
    const d = makeDescriptor({
      category: 'tool_description',
      id: 'read_file_tool',
      tier: 'high-risk',
    });
    const desc =
      '读本地文件。按 offset/limit 分页。' +
      '失败时看 envelope 的 error_kind 字段（13 类）。' +
      '返回 cat -n 格式，行号前缀只显示用，不能进 edit_file 的 old_string。' +
      '`(line truncated to 2000 chars)` marker 表示单行过长（minified / 巨型日志）—— 不要 retry。' +
      '图片 banner 含 `resized from ...`，细节看不清告诉用户走云端解析，不要本地重读。';
    const r = checkToolHardContract(d, desc);
    expect(r.ok).toBe(true);
    expect(r.missingTopics).toEqual([]);
  });

  it('high-risk run_terminal_command 全覆盖 → ok', () => {
    const d = makeDescriptor({
      category: 'tool_description',
      id: 'run_terminal_command_tool',
      tier: 'high-risk',
    });
    const desc =
      '在 workspace 里执行 shell 命令；切目录与 env 见 <shell_runtime>。' +
      'wait_ms=0 把长任务 background 化，命令完成时 push 通知会激活下一轮 turn。' +
      '等待场景矩阵：pattern 等输出；勿套用其它 shell。' +
      '禁交互命令（vim / mysql -it 等）。' +
      '找文件用 grep_search / read_file / edit_file 等专用 FC，别用 cat / grep / find。' +
      'stdout > 30KB 自动落盘 full_output_path。';
    const r = checkToolHardContract(d, desc);
    expect(r.ok).toBe(true);
  });

  it('high-risk run_terminal_command 缺等待场景矩阵主题 → 拦截并报具体 topic', () => {
    const d = makeDescriptor({
      category: 'tool_description',
      id: 'run_terminal_command_tool',
      tier: 'high-risk',
    });
    const desc =
      '在 workspace 里执行 shell 命令；见 <shell_runtime>。' +
      'wait_ms=0 把长任务 background 化。' +
      '禁交互命令。grep_search / read_file / edit_file 用专用工具。' +
      'stdout > 30KB 自动落盘 full_output_path。';
    const r = checkToolHardContract(d, desc);
    expect(r.ok).toBe(false);
    expect(r.missingTopics.map((t) => t.name)).toEqual(['等待场景矩阵']);
  });

  it('high-risk edit_file 缺 replace_all + .md trailing space → 拦截', () => {
    const d = makeDescriptor({
      category: 'tool_description',
      id: 'edit_file_tool',
      tier: 'high-risk',
    });
    // 只覆盖最基本 4 主题，缺 2 个新加 topic
    const desc =
      '编辑文件。提供 old_string + new_string 必须不同。' +
      '先用 read_file 取文件内容当 old_string。' +
      'new_string 字面写入：tab 缩进项目必须用 tab。';
    const r = checkToolHardContract(d, desc);
    expect(r.ok).toBe(false);
    const missing = r.missingTopics.map((t) => t.name);
    expect(missing).toContain('old_string 不唯一时 replace_all');
    expect(missing).toContain('.md trailing space 语义');
  });

  it('host-side 工具不在 HARD_CONTRACT_KEYWORDS 中 → applicable=false', () => {
    // mcp_call_tool_tool 是 source='host'，故意不登记 topics
    const d = makeDescriptor({
      category: 'tool_description',
      id: 'mcp_call_tool_tool',
      tier: 'high-risk',
    });
    const r = checkToolHardContract(d, 'any text');
    expect(r.applicable).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.missingTopics).toEqual([]);
  });

  it('actualLength + budget 字段被填回，便于上层组合报错', () => {
    const d = makeDescriptor({
      category: 'tool_description',
      id: 'edit_file_tool',
      tier: 'high-risk',
      charBudget: 1500,
    });
    const desc = '内容 old_string new_string read_file 字面';
    const r = checkToolHardContract(d, desc);
    expect(r.actualLength).toBe(desc.length);
    expect(r.budget).toBe(1500);
  });
});

describe('checkNoDeprecatedTerms (P7-γ 防漂移反向 audit)', () => {
  it('DEPRECATED_PARAM_TERMS 至少含 run_in_background + background_task_id', () => {
    const olds = DEPRECATED_PARAM_TERMS.map((t) => t.oldTerm);
    expect(olds).toContain('run_in_background');
    expect(olds).toContain('background_task_id');
  });

  it('干净文本 → ok=true', () => {
    const r = checkNoDeprecatedTerms(
      '用 wait_ms: 0 把命令背景化，命令完成时 push 通知会激活下一轮 turn。',
    );
    expect(r.ok).toBe(true);
    expect(r.hits).toEqual([]);
  });

  it('文本含 run_in_background → 命中并报新术语', () => {
    const r = checkNoDeprecatedTerms(
      'Pass the `background_task_id` returned by a `run_terminal_command` call with `run_in_background: true`.',
    );
    expect(r.ok).toBe(false);
    const olds = r.hits.map((h) => h.oldTerm);
    expect(olds).toContain('run_in_background');
    expect(olds).toContain('background_task_id');
    const wm = r.hits.find((h) => h.oldTerm === 'run_in_background')!;
    expect(wm.newTerm).toBe('wait_ms: 0');
    expect(wm.reason).toContain('2026-05-18');
  });

  it('caller 可传子集 terms', () => {
    // 文本只含 run_in_background，传子集 background_task_id（subset 2）→ 不命中
    const r = checkNoDeprecatedTerms(
      '文本只含 run_in_background，不含旧 envelope 字段名。',
      [DEPRECATED_PARAM_TERMS[1]!],
    );
    expect(r.ok).toBe(true);
  });

  it('hit.index 是字符偏移（便于 caller 定位）', () => {
    const text = '前缀 ABC run_in_background DEF';
    const r = checkNoDeprecatedTerms(text);
    expect(r.hits[0]!.index).toBe(text.indexOf('run_in_background'));
  });
});

// ─── 阶段 6 议题 3 新增 helper 单测 ─────────────────────────────────────

describe('collectInputSchemaFieldDescriptions (阶段 6 议题 3)', () => {
  it('扁平 schema：properties.* 每个 description 都被收齐 + 路径正确', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        offset: { type: 'number', description: '起始行（从 0 起算）' },
      },
    };
    const fields = collectInputSchemaFieldDescriptions(schema);
    expect(fields.length).toBe(2);
    const byPath = new Map(fields.map((f) => [f.path, f.text]));
    expect(byPath.get('properties.path')).toBe('文件绝对路径');
    expect(byPath.get('properties.offset')).toBe('起始行（从 0 起算）');
  });

  it('嵌套 array.items：路径串联 items.properties.*', () => {
    const schema = {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '问题稳定 id' },
              prompt: { type: 'string', description: '问题正文' },
            },
          },
        },
      },
    };
    const fields = collectInputSchemaFieldDescriptions(schema);
    const paths = fields.map((f) => f.path).sort();
    expect(paths).toEqual([
      'properties.questions.items.properties.id',
      'properties.questions.items.properties.prompt',
    ]);
  });

  it('无 description 节点静默跳过（type-only 字段）', () => {
    const schema = {
      type: 'object',
      properties: { foo: { type: 'string' }, bar: { type: 'number' } },
    };
    expect(collectInputSchemaFieldDescriptions(schema)).toEqual([]);
  });

  it('非 object 输入返回空数组（防御）', () => {
    expect(collectInputSchemaFieldDescriptions(null)).toEqual([]);
    expect(collectInputSchemaFieldDescriptions(undefined)).toEqual([]);
    expect(collectInputSchemaFieldDescriptions('string')).toEqual([]);
  });
});

describe('isHighRiskKeyField / getFieldBudget / checkFieldCharBudget', () => {
  it('web_search.search_term 遵守 medium 字段预算', () => {
    const r = checkFieldCharBudget(
      'web_search_tool',
      'medium',
      'properties.search_term',
      '搜'.repeat(151),
    );
    expect(r.ok).toBe(false);
    expect(r.budget).toBe(150);
  });

  it('run_terminal_command_tool 的 wait_ms 字段判定为关键字段', () => {
    // HARD_CONTRACT_KEYWORDS['run_terminal_command_tool'] 含 `wait_ms` 关键词
    expect(isHighRiskKeyField('run_terminal_command_tool', 'properties.wait_ms')).toBe(true);
  });

  it('未登记 HARD_CONTRACT 的工具任一字段都不是关键字段', () => {
    expect(isHighRiskKeyField('ask_user_tool', 'properties.questions')).toBe(false);
  });

  it('字段路径不含 HARD_CONTRACT 关键词 → 非关键字段', () => {
    expect(isHighRiskKeyField('run_terminal_command_tool', 'properties.foo_unknown')).toBe(false);
  });

  it('getFieldBudget 政策档位正确', () => {
    expect(getFieldBudget('high-risk', true)).toBe(300);
    expect(getFieldBudget('high-risk', false)).toBe(200);
    expect(getFieldBudget('medium', false)).toBe(150);
    expect(getFieldBudget('low-risk', false)).toBe(150);
  });

  it('checkFieldCharBudget high-risk 关键字段：≤300 算 OK', () => {
    const r = checkFieldCharBudget(
      'run_terminal_command_tool',
      'high-risk',
      'properties.wait_ms',
      'x'.repeat(300),
    );
    expect(r.ok).toBe(true);
    expect(r.budget).toBe(300);
    expect(r.isKeyField).toBe(true);
  });

  it('checkFieldCharBudget high-risk 关键字段：超 300 → 报错', () => {
    const r = checkFieldCharBudget(
      'run_terminal_command_tool',
      'high-risk',
      'properties.wait_ms',
      'x'.repeat(400),
    );
    expect(r.ok).toBe(false);
    expect(r.actual).toBe(400);
  });

  it('checkFieldCharBudget low-risk 字段：≤150 算 OK', () => {
    const r = checkFieldCharBudget(
      'ask_user_tool',
      'low-risk',
      'properties.questions',
      'x'.repeat(150),
    );
    expect(r.ok).toBe(true);
    expect(r.budget).toBe(150);
    expect(r.isKeyField).toBe(false);
  });
});

describe('checkFieldLanguageDiscipline (P3-field 语言纪律)', () => {
  it('短字段 < 20 字 → 返回 ok=true（信号弱不查）', () => {
    const r = checkFieldLanguageDiscipline('zh', 'Optional tag', false);
    expect(r.ok).toBe(true);
  });

  it('declared=zh 但实际全英 → ok=false', () => {
    const text =
      'Stable identifier for this option used by the UI to track selection across multiple sessions.';
    const r = checkFieldLanguageDiscipline('zh', text, false);
    expect(r.ok).toBe(false);
    expect(r.detected).toBe('en');
  });

  it('declared=zh 且实际中文 → ok=true', () => {
    const text =
      '本次 tool_call 最多阻塞等待多少毫秒，超时不杀进程，返回 status running 让 LLM 用 await 工具继续等。';
    const r = checkFieldLanguageDiscipline('zh', text, false);
    expect(r.ok).toBe(true);
    expect(r.detected).toBe('zh');
  });

  it('declared=en 但无 languageExceptionReason → ok=false', () => {
    const text =
      'The complete question to ask the user. Should be clear specific and end with a question mark.';
    const r = checkFieldLanguageDiscipline('en', text, false);
    expect(r.ok).toBe(false);
  });

  it('declared=en + hasException=true + 英文文本 → ok=true', () => {
    const text =
      'The complete question to ask the user. Should be clear specific and end with a question mark.';
    const r = checkFieldLanguageDiscipline('en', text, true);
    expect(r.ok).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import {
  AgentBackendConfigSchema,
  PromptForwardPayloadSchema,
  resolveDisabledToolPrefixes,
  matchDisabledToolDomain,
  matchDisabledToolPrefix,
} from '@tabtin/agent-wire';

describe('AgentBackendConfigSchema — disabled_apps field', () => {
  it('preserves disabled_apps when present', () => {
    const input = {
      type: 'claude-code',
      disabled_apps: ['tabdata', 'tabslide'],
    };
    const result = AgentBackendConfigSchema.parse(input);
    expect(result.disabled_apps).toEqual(['tabdata', 'tabslide']);
  });

  it('preserves disabled_tool_prefixes when present', () => {
    const input = {
      type: 'claude-code',
      disabled_apps: ['tabdata'],
      disabled_tool_prefixes: ['sql', 'tabdata'],
    };
    const result = AgentBackendConfigSchema.parse(input);
    expect(result.disabled_tool_prefixes).toEqual(['sql', 'tabdata']);
  });

  it('omits disabled_apps when not present (optional field)', () => {
    const input = { type: 'codex' };
    const result = AgentBackendConfigSchema.parse(input);
    expect(result.disabled_apps).toBeUndefined();
  });

  it('accepts empty disabled_apps array', () => {
    const input = { type: 'codex', disabled_apps: [] };
    const result = AgentBackendConfigSchema.parse(input);
    expect(result.disabled_apps).toEqual([]);
  });
});

describe('resolveDisabledToolPrefixes', () => {
  it('returns empty when no disabled apps', () => {
    expect(resolveDisabledToolPrefixes([], undefined)).toEqual([]);
    expect(resolveDisabledToolPrefixes(undefined, undefined)).toEqual([]);
  });

  it('uses explicit prefixes when provided', () => {
    const result = resolveDisabledToolPrefixes(['tabdata'], ['sql', 'tabdata', 'custom']);
    expect(result).toEqual(['sql', 'tabdata', 'custom']);
  });

  it('derives prefixes from app IDs when no explicit prefixes', () => {
    const result = resolveDisabledToolPrefixes(['tabdoc', 'tabslide'], undefined);
    expect(result).toContain('tabdoc');
    expect(result).toContain('tabslide');
    expect(result).toHaveLength(2);
  });

  it('includes extra tool domains for tabdata (sql)', () => {
    const result = resolveDisabledToolPrefixes(['tabdata'], undefined);
    expect(result).toContain('tabdata');
    expect(result).toContain('sql');
  });

  it('deduplicates prefixes', () => {
    const result = resolveDisabledToolPrefixes(['tabdata', 'tabdata'], undefined);
    const sqlCount = result.filter(p => p === 'sql').length;
    const tabdataCount = result.filter(p => p === 'tabdata').length;
    expect(sqlCount).toBe(1);
    expect(tabdataCount).toBe(1);
  });

  it('ignores empty explicit prefixes array and falls back to derivation', () => {
    const result = resolveDisabledToolPrefixes(['tabdoc'], []);
    expect(result).toContain('tabdoc');
  });
});

describe('matchDisabledToolPrefix', () => {
  it('returns null for empty prefix list', () => {
    expect(matchDisabledToolPrefix('sql_execute', [])).toBeNull();
  });

  it('matches exact tool name', () => {
    expect(matchDisabledToolPrefix('tabdoc', ['tabdoc'])).toBe('tabdoc');
  });

  it('matches tool name with prefix_', () => {
    expect(matchDisabledToolPrefix('sql_execute', ['sql'])).toBe('sql');
  });

  it('matches tabdata_create_table', () => {
    expect(matchDisabledToolPrefix('tabdata_create_table', ['tabdata', 'sql'])).toBe('tabdata');
  });

  it('does not match partial prefix (no underscore boundary)', () => {
    expect(matchDisabledToolPrefix('tabdocx_create', ['tabdoc'])).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(matchDisabledToolPrefix('SQL_Execute', ['sql'])).toBe('sql');
    expect(matchDisabledToolPrefix('TABDOC_CREATE', ['tabdoc'])).toBe('tabdoc');
  });

  it('matches underscore-delimited domain tokens inside legacy tool names', () => {
    expect(matchDisabledToolPrefix('execute_in_terminal', ['terminal'])).toBe('terminal');
    expect(matchDisabledToolPrefix('read_terminal_output', ['terminal'])).toBe('terminal');
  });

  it('returns first matched prefix', () => {
    const result = matchDisabledToolPrefix('sql_query', ['tabdata', 'sql']);
    expect(result).toBe('sql');
  });

  it('does not match unrelated tool names', () => {
    expect(matchDisabledToolPrefix('read_file', ['tabdata', 'sql'])).toBeNull();
    expect(matchDisabledToolPrefix('bash', ['tabdoc'])).toBeNull();
  });

  it('handles tool name that is a prefix substring without underscore', () => {
    expect(matchDisabledToolPrefix('sqlinjection', ['sql'])).toBeNull();
  });
});

describe('matchDisabledToolDomain', () => {
  it('matches direct domain prefixes', () => {
    expect(matchDisabledToolDomain('sql_execute', ['sql'])).toBe('sql');
  });

  it('matches runtime tool aliases from shared metadata', () => {
    expect(matchDisabledToolDomain('bash', ['terminal'])).toBe('terminal');
    expect(matchDisabledToolDomain('document_read', ['tabdoc'])).toBe('tabdoc');
    expect(matchDisabledToolDomain('memory_search', ['tabmemo'])).toBe('tabmemo');
  });

  it('matches MCP tool aliases from shared metadata', () => {
    expect(matchDisabledToolDomain('tabtin_sql_query', ['sql'])).toBe('sql');
    expect(matchDisabledToolDomain('tabtin_table_query', ['tabdata'])).toBe('tabdata');
    expect(matchDisabledToolDomain('tabtin_doc_read', ['tabdoc'])).toBe('tabdoc');
  });

  it('returns null for unrelated aliases', () => {
    expect(matchDisabledToolDomain('web_search', ['tabdoc'])).toBeNull();
  });
});

// M5 双轨清零：authorization_preset 字段已从 PromptForwardPayloadSchema 退场（spec §10.2）。
// 原测试 "preserves known" / "rejects unknown" 已删——字段不在 schema 里，断言它存在是误导。
describe('PromptForwardPayloadSchema — post-v3 regression', () => {
  const basePayload = {
    task_id: 'task-1',
    prompt: 'hello',
    attachments: [],
    agent_config: { type: 'local' },
  };

  it('defaults missing attachments to an empty array', () => {
    const { attachments } = PromptForwardPayloadSchema.parse({
      task_id: 'task-1',
      prompt: 'hello',
      agent_config: { type: 'local' },
    });
    expect(attachments).toEqual([]);
  });

  it('accepts empty prompt when attachments carry user input', () => {
    const result = PromptForwardPayloadSchema.parse({
      task_id: 'task-1',
      prompt: '',
      attachments: [{ type: 'image', url: 'https://example.com/a.png' }],
      agent_config: { type: 'local' },
    });
    expect(result.prompt).toBe('');
    expect(result.attachments).toEqual([
      { type: 'image', url: 'https://example.com/a.png' },
    ]);
  });

  it('preserves local runtime routing fields', () => {
    const result = PromptForwardPayloadSchema.parse({
      ...basePayload,
      model_id: 'model-1',
      system_prompt: 'system override',
      agent_id: 'agent-1',
      attachment_strategy: 'local_first',
    });
    expect(result.model_id).toBe('model-1');
    expect(result.system_prompt).toBe('system override');
    expect(result.agent_id).toBe('agent-1');
    expect(result.attachment_strategy).toBe('local_first');
  });

  it('rejects unknown attachment_strategy values', () => {
    expect(() => PromptForwardPayloadSchema.parse({
      ...basePayload,
      attachment_strategy: 'local-first',
    })).toThrow();
  });
});

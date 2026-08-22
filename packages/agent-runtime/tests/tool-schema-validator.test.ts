/**
 * FR-07 — JSON Schema validator behaviour + 19 builtin tool coverage.
 *
 * The validator is hand-rolled so we keep the regression coverage tight:
 * every supported rule (type / required / enum / format / minItems / additionalProperties)
 * gets at least one positive + one negative case, and the suite locks in
 * the "all 19 builtin tools' valid sample inputs pass" promise that justified
 * not pulling in ajv.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  validateToolInput,
  summarizeValidationErrors,
  DEFAULT_TOOL_SCHEMA_VALIDATION,
} from '../src/engine/tooling/tool-schema-validator.js';
import type {
  JsonSchema,
} from '../src/engine/contracts/tools.js';
import { WEB_SEARCH_FRESHNESS_FORMAT } from '../src/engine/tooling/web-search-freshness.js';

import {
  createCoreTools,
  createWebTools,
  createPresentationTools,
} from '../src/tools/index.js';
// W3 (2026-05-10): `createContextTools` deleted along with
// `summarize_context` and `retrieve_tool_result`. The "all builtin tools'
// valid sample inputs pass" promise drops these two from the matrix.


// ─── Primitive types ────────────────────────────────────────────────

describe('validateToolInput — primitive type checks', () => {
  it('accepts a matching string', () => {
    const r = validateToolInput({ type: 'string' }, 'hello');
    expect(r.valid).toBe(true);
  });

  it('rejects wrong primitive type', () => {
    const r = validateToolInput({ type: 'string' }, 42);
    expect(r.valid).toBe(false);
    expect(r.errors[0].rule).toBe('type');
    expect(r.errors[0].message).toContain('expected string');
    expect(r.errors[0].message).toContain('integer');
  });

  it('treats integer vs number distinctly', () => {
    expect(validateToolInput({ type: 'integer' }, 3).valid).toBe(true);
    expect(validateToolInput({ type: 'integer' }, 3.14).valid).toBe(false);
    expect(validateToolInput({ type: 'number' }, 3.14).valid).toBe(true);
  });

  it('rejects NaN / Infinity for number / integer', () => {
    expect(validateToolInput({ type: 'number' }, NaN).valid).toBe(false);
    expect(validateToolInput({ type: 'number' }, Infinity).valid).toBe(false);
  });

  it('handles type union (e.g. string | null)', () => {
    const schema: JsonSchema = { type: ['string', 'null'] };
    expect(validateToolInput(schema, 'x').valid).toBe(true);
    expect(validateToolInput(schema, null).valid).toBe(true);
    expect(validateToolInput(schema, 7).valid).toBe(false);
  });

  it('is lenient when schema declares no type', () => {
    expect(validateToolInput({}, 'anything').valid).toBe(true);
    expect(validateToolInput({}, 99).valid).toBe(true);
    expect(validateToolInput(undefined, 'whatever').valid).toBe(true);
  });
});

// ─── required / properties / additionalProperties ───────────────────

describe('validateToolInput — object shape', () => {
  it('flags every missing required field', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    };
    const r = validateToolInput(schema, { path: '/tmp/foo' });
    expect(r.valid).toBe(false);
    const missing = r.errors.find((e) => e.rule === 'required' && e.path === 'content');
    expect(missing).toBeTruthy();
    expect(missing?.message).toContain('missing required field');
  });

  it('treats undefined property as missing required', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    };
    const r = validateToolInput(schema, { command: undefined });
    expect(r.valid).toBe(false);
    expect(r.errors[0].rule).toBe('required');
  });

  it('rejects unexpected fields when additionalProperties is false', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { foo: { type: 'string' } },
      additionalProperties: false,
    };
    const r = validateToolInput(schema, { foo: 'ok', extra: 'no' });
    expect(r.valid).toBe(false);
    expect(r.errors[0].rule).toBe('additionalProperties');
    expect(r.errors[0].details?.extra_keys).toEqual(['extra']);
  });

  it('allows unexpected fields when additionalProperties is omitted', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { foo: { type: 'string' } },
    };
    const r = validateToolInput(schema, { foo: 'ok', extra: 'sure' });
    expect(r.valid).toBe(true);
  });

  it('validates additional property values when additionalProperties is a schema', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {},
      additionalProperties: { type: 'string' },
    };
    expect(validateToolInput(schema, { FOO: 'bar' }).valid).toBe(true);
    const bad = validateToolInput(schema, { FOO: 1 });
    expect(bad.valid).toBe(false);
    expect(bad.errors.some((e) => e.path === 'FOO' && e.rule === 'type')).toBe(true);
  });

  it('recurses into nested object properties', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: { tag: { type: 'string' } },
          required: ['tag'],
        },
      },
      required: ['meta'],
    };
    const r = validateToolInput(schema, { meta: { tag: 1 } });
    expect(r.valid).toBe(false);
    const wrongType = r.errors.find((e) => e.path === 'meta.tag');
    expect(wrongType).toBeTruthy();
    expect(wrongType?.rule).toBe('type');
  });
});

// ─── enum / arrays ──────────────────────────────────────────────────

describe('validateToolInput — enum + arrays', () => {
  it('accepts allowed enum value', () => {
    const r = validateToolInput({ type: 'string', enum: ['a', 'b'] }, 'a');
    expect(r.valid).toBe(true);
  });

  it('rejects out-of-enum values with allowed_values payload', () => {
    const r = validateToolInput({ type: 'string', enum: ['a', 'b'] }, 'c');
    expect(r.valid).toBe(false);
    expect(r.errors[0].rule).toBe('enum');
    expect(r.errors[0].details?.allowed_values).toEqual(['a', 'b']);
  });

  it('enforces minItems on arrays', () => {
    const schema: JsonSchema = {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
    };
    expect(validateToolInput(schema, []).errors[0].rule).toBe('minItems');
    expect(validateToolInput(schema, ['x']).valid).toBe(true);
  });

  it('enforces maxItems on arrays', () => {
    const schema: JsonSchema = {
      type: 'array',
      items: { type: 'number' },
      maxItems: 2,
    };
    expect(validateToolInput(schema, [1, 2, 3]).errors[0].rule).toBe('maxItems');
  });

  it('recurses into array items with positional path', () => {
    const schema: JsonSchema = {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    };
    const r = validateToolInput(schema, [{ id: 'ok' }, {}]);
    expect(r.valid).toBe(false);
    const missingId = r.errors.find((e) => e.path === '[1].id');
    expect(missingId?.rule).toBe('required');
  });
});

// ─── string format (allowlisted; no arbitrary pattern RegExp) ───────

describe('validateToolInput — string format', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      freshness: {
        type: 'string',
        format: WEB_SEARCH_FRESHNESS_FORMAT,
      },
    },
  };

  it('accepts presets, single days, and forward ranges', () => {
    expect(validateToolInput(schema, { freshness: 'oneDay' }).valid).toBe(true);
    expect(validateToolInput(schema, { freshness: '2026-07-17' }).valid).toBe(true);
    expect(validateToolInput(schema, { freshness: '2026-01-01..2026-07-17' }).valid).toBe(true);
    expect(validateToolInput(schema, { freshness: '2024-02-29' }).valid).toBe(true);
  });

  it('rejects non-matching strings with stable path and actionable hint', () => {
    const result = validateToolInput(schema, { freshness: 'whenever' });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].rule).toBe('format');
    expect(result.errors[0].path).toBe('freshness');
    expect(result.errors[0].details?.expected_format).toBe(WEB_SEARCH_FRESHNESS_FORMAT);
    expect(summarizeValidationErrors(result.errors)).toContain(
      `field 'freshness' must match format "${WEB_SEARCH_FRESHNESS_FORMAT}"`,
    );
  });

  it('rejects impossible calendar dates and reversed ranges at schema layer', () => {
    expect(validateToolInput(schema, { freshness: '2026-02-30' }).valid).toBe(false);
    expect(validateToolInput(schema, { freshness: '2026-12-31..2026-01-01' }).valid).toBe(false);
  });

  it('does not apply format to non-string values already handled by type validation', () => {
    const result = validateToolInput(schema, { freshness: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.rule)).toEqual(['type']);
  });

  it('unknown format fails as unsupported without executing RegExp', () => {
    const unknownFormatSchema: JsonSchema = {
      type: 'string',
      format: 'email',
    };
    const regexpSpy = vi.spyOn(globalThis, 'RegExp');
    const result = validateToolInput(unknownFormatSchema, 'user@example.com');
    expect(result.valid).toBe(false);
    expect(result.errors[0].rule).toBe('unsupported');
    expect(result.errors[0].details?.feature).toBe('format');
    expect(result.errors[0].details?.expected_format).toBe('email');
    expect(summarizeValidationErrors(result.errors)).toContain('unsupported schema feature');
    expect(regexpSpy).not.toHaveBeenCalled();
    regexpSpy.mockRestore();
  });

  it('ignores schema.pattern without compiling or executing RegExp (no ReDoS path)', () => {
    const catastrophic: JsonSchema = {
      type: 'string',
      pattern: '^(a+)+$',
    };
    const regexpSpy = vi.spyOn(globalThis, 'RegExp');
    const value = `${'a'.repeat(30)}!`;
    const result = validateToolInput(catastrophic, value);
    expect(result.valid).toBe(true);
    expect(regexpSpy).not.toHaveBeenCalled();
    regexpSpy.mockRestore();
  });
});

// ─── minimum / maximum (numeric bounds) ─────────────────────────────

describe('validateToolInput — numeric minimum / maximum', () => {
  it('accepts number at minimum boundary', () => {
    const r = validateToolInput({ type: 'number', minimum: 0 }, 0);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects number below minimum with stable rule/path', () => {
    const r = validateToolInput({ type: 'number', minimum: 0 }, -0.1);
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].rule).toBe('minimum');
    expect(r.errors[0].path).toBe('');
    expect(r.errors[0].message).toContain('at least');
    expect(r.errors[0].details?.expected_min).toBe(0);
    expect(r.errors[0].details?.actual).toBe(-0.1);
  });

  it('accepts number at maximum boundary', () => {
    const r = validateToolInput({ type: 'number', maximum: 100 }, 100);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects number above maximum with stable rule/path', () => {
    const r = validateToolInput({ type: 'number', maximum: 100 }, 100.5);
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].rule).toBe('maximum');
    expect(r.errors[0].path).toBe('');
    expect(r.errors[0].message).toContain('at most');
    expect(r.errors[0].details?.expected_max).toBe(100);
    expect(r.errors[0].details?.actual).toBe(100.5);
  });

  it('reports nested property path for out-of-range numbers', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          properties: {
            timeout: { type: 'number', minimum: 1, maximum: 60 },
          },
          required: ['timeout'],
        },
      },
      required: ['config'],
    };
    const tooLow = validateToolInput(schema, { config: { timeout: 0 } });
    expect(tooLow.valid).toBe(false);
    const minErr = tooLow.errors.find((e) => e.rule === 'minimum');
    expect(minErr?.path).toBe('config.timeout');

    const tooHigh = validateToolInput(schema, { config: { timeout: 61 } });
    expect(tooHigh.valid).toBe(false);
    const maxErr = tooHigh.errors.find((e) => e.rule === 'maximum');
    expect(maxErr?.path).toBe('config.timeout');
  });

  it('does not emit minimum/maximum errors for non-number values', () => {
    // Wrong type must surface as `type`, never as a numeric-bound miss.
    const asString = validateToolInput({ type: 'number', minimum: 1, maximum: 10 }, '5');
    expect(asString.valid).toBe(false);
    expect(asString.errors.every((e) => e.rule === 'type')).toBe(true);
    expect(asString.errors.some((e) => e.rule === 'minimum' || e.rule === 'maximum')).toBe(false);

    // Schema with bounds but no numeric type declared — string input is not
    // subject to numeric bounds (lenient when type is absent; bounds only apply
    // to finite numbers).
    const untyped = validateToolInput({ minimum: 1, maximum: 10 }, '5');
    expect(untyped.valid).toBe(true);
    expect(untyped.errors).toEqual([]);
  });
});

// ─── error caps + summary ───────────────────────────────────────────

describe('validateToolInput — bounded error reporting', () => {
  it('caps total errors emitted', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`f${i}`, { type: 'string' }]),
      ),
      required: Array.from({ length: 30 }, (_, i) => `f${i}`),
    };
    const r = validateToolInput(schema, {});
    // MAX_ERRORS_PER_INPUT = 12 in the implementation
    expect(r.errors.length).toBeLessThanOrEqual(12);
  });

  it('formats a human-friendly summary', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a', 'b'],
    };
    const r = validateToolInput(schema, {});
    const summary = summarizeValidationErrors(r.errors);
    expect(summary).toContain("Missing required field 'a'");
    expect(summary).toContain("Missing required field 'b'");
  });

  it('truncates summaries beyond max with overflow hint', () => {
    const errors = Array.from({ length: 6 }, (_, i) => ({
      path: `f${i}`,
      rule: 'required' as const,
      message: 'missing required field',
    }));
    const summary = summarizeValidationErrors(errors, 2);
    expect(summary).toMatch(/\(\+4 more\)/);
  });
});

// ─── Defaults ───────────────────────────────────────────────────────

describe('FR-07 defaults', () => {
  it('default validation level is warn (backward-compatible)', () => {
    expect(DEFAULT_TOOL_SCHEMA_VALIDATION).toBe('warn');
  });
});

// ─── All in-package builtin tools pass with valid inputs ────────────
// 12 tools come from `packages/agent-runtime/src/tools/*` (core 4 +
// control 1 + web 2 + document 1 + context 2 + presentation 1 +
// search 1). The "19 FC tools" total mentioned in the PRD includes
// host-injected ones (sub-agent + 7 MCP tools wired in
// ElectronToolProvider) which are out of scope for this regression
// net — the host owns those schemas and validates them in its own
// integration tests.
//
// The lock here is: any future schema in this package using a feature
// the validator does NOT support (e.g. unknown `format`, `$ref`)
// will show up as a false positive on the known-good sample input
// instead of silently letting bad input through to `tool.execute()`.

describe('FR-07 — every in-package builtin tool accepts a valid sample input', () => {
  const builtinTools = [
    ...createCoreTools({}),
    ...createWebTools({ apiBaseUrl: 'http://localhost/api' }),
    // ：document-tools 已迁宿主业务工具包（不再是 in-package 工具）。
    // W3 (2026-05-10): `createContextTools` deleted (summarize_context +
    // retrieve_tool_result removed) — see imports above.
    ...createPresentationTools({
      supportedResourceTypes: new Set(['table', 'doc', 'slide', 'video', 'site', 'tracker']),
      autoOpenPolicy: (t) => t !== 'slide',
    }),
  ];

  // Sample inputs hand-picked to exercise every required field of every
  // builtin tool. If a tool gets a new required field, this test surfaces
  // it as a regression.
  const samples: Record<string, unknown> = {
    // ask_user 兼容 ask_choice 场景；ask_form 处理多字段表单。
    //  (2026-07-08): request_approval 已下架，样本随之移除。
    ask_user: {
      title: 'Pick a color',
      questions: [
        {
          id: 'q1',
          prompt: 'Which color do you prefer?',
          header: 'Color',
          options: [
            { id: 'a', label: 'A', description: 'Use option A.' },
            { id: 'b', label: 'B', description: 'Use option B.' },
          ],
        },
      ],
    },
    ask_form: {
      title: 'Project info',
      fields: [
        { key: 'name', label: 'Project name', type: 'input', placeholder: 'TabTin' },
        { key: 'desc', label: 'Description', type: 'textarea', description: 'Short summary of the project.' },
      ],
    },
    todo: { action: 'open', items: [{ id: 't1', content: 'do x', status: 'pending' }],
    },
    web_fetch: { url: 'https://example.com' },
    web_search: { search_term: 'tabtin agent runtime' },
    parse_document: { file_id: 'abc-123' },
    // W3 (2026-05-10): summarize_context + retrieve_tool_result removed.
    present_to_user: {
      items: [{ kind: 'image' }],
      summary: 'demo',
    },
    show_widget: {
      summary: 'k8s 三层架构示意图',
      format: 'svg',
      code: '<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>',
    },
  };

  for (const tool of builtinTools) {
    it(`accepts valid sample for tool '${tool.name}'`, () => {
      const sample = samples[tool.name];
      expect(sample, `missing sample input for '${tool.name}' — please add to samples map`).toBeDefined();
      const r = validateToolInput(tool.inputSchema, sample);
      if (!r.valid) {
        // Make the failure self-diagnostic.
        // eslint-disable-next-line no-console
        console.error(`Validation failed for '${tool.name}':`, r.errors);
      }
      expect(r.valid).toBe(true);
    });
  }

  it('accepts ask_form fields without key because execute derives it from label', () => {
    const askForm = builtinTools.find((t) => t.name === 'ask_form')!;
    const r = validateToolInput(askForm.inputSchema, {
      title: 'Create tracker',
      fields: [{ label: 'Task name', type: 'input', placeholder: 'Daily reminder' }],
    });
    expect(r.valid).toBe(true);
  });

  it('accepts ask_form prompt/id aliases before execute normalizes them', () => {
    const askForm = builtinTools.find((t) => t.name === 'ask_form')!;
    const r = validateToolInput(askForm.inputSchema, {
      title: 'Create tracker',
      fields: [{ id: 'task_name', prompt: 'Task name', type: 'input' }],
    });
    expect(r.valid).toBe(true);
  });

  it('rejects todo with invalid status enum', () => {
    const todo = builtinTools.find((t) => t.name === 'todo')!;
    const r = validateToolInput(todo.inputSchema, { action: 'open', items: [{ id: 't', content: 'x', status: 'unknown' }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.find((e) => e.rule === 'enum')).toBeTruthy();
  });
});

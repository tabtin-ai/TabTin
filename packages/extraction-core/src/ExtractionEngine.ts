import { load } from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { ExtractionSchema } from '@tabtin/crawl-contracts';
import { type CheerioEl, resolveSelector, textOf, attrOf, htmlOf } from './selectors/css';
import { applyTransform, applyArrayTransform } from './transforms/index';
import { validate } from './transforms/validators';

type Field = ExtractionSchema['fields'][number];

const DEFAULT_MAX_ITEMS = 1000;

export interface ExtractionResult {
  data: Record<string, unknown>[];
  meta: {
    fieldCount: number;
    recordCount: number;
    confidence: number;
    warnings: string[];
  };
}

export interface EngineOptions {
  maxItems?: number;
}

export class ExtractionEngine {
  private maxItems: number;

  constructor(options?: EngineOptions) {
    this.maxItems = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  }

  extract(html: string, schema: ExtractionSchema): ExtractionResult {
    const $ = load(html);
    const warnings: string[] = [];

    const listSel = schema.list_selector || schema.listSelector;
    if (!listSel) {
      return emptyResult(schema, ['No list_selector provided']);
    }

    let items: CheerioEl;
    try {
      items = $(listSel);
    } catch (err) {
      return emptyResult(schema, [
        `Invalid list_selector "${listSel}": ${err instanceof Error ? err.message : err}`,
      ]);
    }

    if (items.length === 0) {
      return emptyResult(schema, [
        `list_selector "${listSel}" matched 0 elements`,
      ]);
    }

    const count = Math.min(items.length, this.maxItems);
    if (items.length > this.maxItems) {
      warnings.push(
        `list_selector matched ${items.length} items, capped at ${this.maxItems}`,
      );
    }

    const docFields = schema.fields.filter(f => f.scope === 'document');
    const itemFields = schema.fields.filter(f => f.scope !== 'document');
    const regularFields = itemFields.filter(f => f.type !== 'computed');
    const computedFields = itemFields.filter(f => f.type === 'computed');

    const docValues: Record<string, unknown> = {};
    for (const field of docFields) {
      docValues[field.name] = this.safeExtract($, null, field, {}, warnings);
    }

    const data: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      const el = items.eq(i);
      const record: Record<string, unknown> = { ...docValues };

      for (const field of regularFields) {
        record[field.name] = this.safeExtract(
          $, el, field, record, warnings, i,
        );
      }

      for (const field of computedFields) {
        record[field.name] = this.safeExtract(
          $, el, field, record, warnings, i,
        );
      }

      data.push(record);
    }

    return {
      data,
      meta: {
        fieldCount: schema.fields.length,
        recordCount: data.length,
        confidence: schema.confidence ?? 0,
        warnings,
      },
    };
  }

  // ─── private ────────────────────────────────────────────

  private safeExtract(
    $: CheerioAPI,
    context: CheerioEl | null,
    field: Field,
    record: Record<string, unknown>,
    warnings: string[],
    rowIndex?: number,
  ): unknown {
    try {
      const raw = this.extractByType($, context, field, record, warnings, rowIndex);
      return this.postProcess(raw, field, warnings);
    } catch (err) {
      const prefix = rowIndex !== undefined ? `Row ${rowIndex}, ` : '';
      warnings.push(
        `${prefix}field "${field.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return field.default?.value ?? null;
    }
  }

  private extractByType(
    $: CheerioAPI,
    ctx: CheerioEl | null,
    field: Field,
    record: Record<string, unknown>,
    warnings: string[],
    rowIndex?: number,
  ): unknown {
    switch (field.type) {
      case 'text':
        return this.doText($, ctx, field);
      case 'attribute':
        return this.doAttribute($, ctx, field);
      case 'html':
        return this.doHtml($, ctx, field);
      case 'regex':
        return this.doRegex($, ctx, field);
      case 'computed':
        return this.doComputed(field, record);
      case 'conditional':
        return this.doConditional($, ctx, field, warnings);
      case 'nested':
        return this.doNested($, ctx, field, warnings, rowIndex);
      case 'xpath':
        warnings.push(`Field "${field.name}": xpath not yet supported`);
        return null;
    }
  }

  // ─── type extractors ───────────────────────────────────

  private doText(
    $: CheerioAPI,
    ctx: CheerioEl | null,
    field: Field,
  ): unknown {
    const els = resolveSelector($, ctx, field.selector);
    if (!els) return null;

    if (field.multiple) {
      const out: string[] = [];
      for (let i = 0; i < els.length; i++) out.push(els.eq(i).text());
      return out;
    }
    return textOf($, els.first());
  }

  private doAttribute(
    $: CheerioAPI,
    ctx: CheerioEl | null,
    field: Field,
  ): unknown {
    if (!field.attribute) return null;
    const els = resolveSelector($, ctx, field.selector);
    if (!els) return null;

    if (field.multiple) {
      const out: (string | undefined)[] = [];
      for (let i = 0; i < els.length; i++) {
        out.push(attrOf(els.eq(i), field.attribute));
      }
      return out;
    }
    return attrOf(els.first(), field.attribute);
  }

  private doHtml(
    $: CheerioAPI,
    ctx: CheerioEl | null,
    field: Field,
  ): unknown {
    const els = resolveSelector($, ctx, field.selector);
    if (!els) return null;

    if (field.multiple) {
      const out: (string | null)[] = [];
      for (let i = 0; i < els.length; i++) out.push(els.eq(i).html());
      return out;
    }
    return htmlOf(els.first());
  }

  private doRegex(
    $: CheerioAPI,
    ctx: CheerioEl | null,
    field: Field,
  ): unknown {
    if (!field.regex) return null;
    const els = resolveSelector($, ctx, field.selector);
    if (!els) return null;

    const pattern = new RegExp(field.regex);

    if (field.multiple) {
      const out: (string | Record<string, string | undefined> | null)[] = [];
      for (let i = 0; i < els.length; i++) {
        const m = els.eq(i).text().match(pattern);
        out.push(m ? captureResult(m, field) : null);
      }
      return out;
    }

    const m = textOf($, els.first()).match(pattern);
    if (!m) return null;
    return captureResult(m, field);
  }

  private doComputed(
    field: Field,
    record: Record<string, unknown>,
  ): unknown {
    if (!field.compute) return null;
    const { expression, inputs } = field.compute;

    let result = expression;
    for (const key of inputs) {
      result = result.replace(
        new RegExp(`\\$\\{${escapeRegex(key)}\\}`, 'g'),
        String(record[key] ?? ''),
      );
    }

    if (/^[\d\s+\-*/().]+$/.test(result) && result.trim().length > 0) {
      try {
        return Function('"use strict"; return (' + result + ')')() as unknown;
      } catch {
        return result;
      }
    }

    return result;
  }

  private doConditional(
    $: CheerioAPI,
    ctx: CheerioEl | null,
    field: Field,
    warnings: string[],
  ): unknown {
    if (!field.conditions?.length) return null;

    for (const rule of field.conditions) {
      const checkEls = resolveSelector($, ctx, rule.if.selector);
      let matched = false;

      if (rule.if.exists !== undefined) {
        matched = rule.if.exists ? !!checkEls : !checkEls;
      } else if (rule.if.text_contains && checkEls) {
        matched = textOf($, checkEls.first()).includes(rule.if.text_contains);
      } else {
        matched = !!checkEls;
      }

      if (!matched) continue;

      if (rule.then.value !== undefined) return rule.then.value;

      if (rule.then.selector) {
        const thenEls = resolveSelector($, ctx, rule.then.selector);
        if (!thenEls) return null;

        switch (rule.then.type) {
          case 'attribute':
            return field.attribute
              ? attrOf(thenEls.first(), field.attribute)
              : null;
          case 'html':
            return htmlOf(thenEls.first());
          default:
            return textOf($, thenEls.first());
        }
      }
    }

    return null;
  }

  private doNested(
    $: CheerioAPI,
    ctx: CheerioEl | null,
    field: Field,
    warnings: string[],
    rowIndex?: number,
  ): unknown {
    if (!field.nested_fields?.length) return null;

    const els = resolveSelector($, ctx, field.selector);
    if (!els) return null;

    if (field.multiple) {
      const results: Record<string, unknown>[] = [];
      for (let i = 0; i < els.length; i++) {
        const nestedCtx = els.eq(i);
        const nested: Record<string, unknown> = {};
        for (const sub of field.nested_fields) {
          nested[sub.name] = this.safeExtract(
            $, nestedCtx, sub, nested, warnings, rowIndex,
          );
        }
        results.push(nested);
      }
      return results;
    }

    const nested: Record<string, unknown> = {};
    for (const sub of field.nested_fields) {
      nested[sub.name] = this.safeExtract(
        $, els.first(), sub, nested, warnings, rowIndex,
      );
    }
    return nested;
  }

  // ─── post-processing ───────────────────────────────────

  private postProcess(
    value: unknown,
    field: Field,
    warnings: string[],
  ): unknown {
    let result = value;

    if (field.filter && result !== null && result !== undefined) {
      result = this.applyFilter(result, field.filter);
    }

    if (field.transform && result !== null && result !== undefined) {
      result = Array.isArray(result)
        ? result.map(v => applyTransform(v, field.transform!))
        : applyTransform(result, field.transform);
    }

    if (field.array_transform && Array.isArray(result)) {
      result = applyArrayTransform(result, field.array_transform);
    }

    if (
      (result === null || result === undefined || result === '') &&
      field.default !== undefined
    ) {
      result = field.default.value;
    }

    if (field.validation) {
      const { valid, error } = validate(result, field.validation);
      if (!valid) {
        warnings.push(`Field "${field.name}" validation: ${error}`);
      }
    }

    if (
      field.required === true &&
      (result === null || result === undefined || result === '')
    ) {
      warnings.push(`Field "${field.name}": required field is empty`);
    }

    return result;
  }

  private applyFilter(
    value: unknown,
    filter: NonNullable<Field['filter']>,
  ): unknown {
    switch (filter.type) {
      case 'not_empty':
        return typeof value === 'string' && value.trim().length === 0
          ? null
          : value;

      case 'regex_match':
        if (!filter.pattern || typeof value !== 'string') return value;
        return new RegExp(filter.pattern).test(value) ? value : null;

      case 'contains':
        if (filter.text === undefined || typeof value !== 'string') return value;
        return value.includes(filter.text) ? value : null;

      case 'range': {
        const num = typeof value === 'number' ? value : Number(value);
        if (isNaN(num)) return null;
        if (filter.min !== undefined && num < filter.min) return null;
        if (filter.max !== undefined && num > filter.max) return null;
        return value;
      }

      default:
        return value;
    }
  }
}

// ─── standalone helpers ────────────────────────────────────

function emptyResult(
  schema: ExtractionSchema,
  warnings: string[],
): ExtractionResult {
  return {
    data: [],
    meta: {
      fieldCount: schema.fields.length,
      recordCount: 0,
      confidence: 0,
      warnings,
    },
  };
}

function captureResult(
  match: RegExpMatchArray,
  field: Field,
): string | Record<string, string | undefined> {
  if (field.capture_groups) {
    const grouped: Record<string, string | undefined> = {};
    for (const [name, idx] of Object.entries(field.capture_groups)) {
      grouped[name] = match[idx];
    }
    return grouped;
  }
  return match[1] ?? match[0];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

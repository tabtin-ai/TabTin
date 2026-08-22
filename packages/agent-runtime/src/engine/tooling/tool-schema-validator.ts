/**
 * FR-07 — Lightweight JSON Schema validator for tool inputs.
 *
 * Why hand-rolled instead of `ajv`:
 *   1. **Coverage matches actual usage**: every TabTin built-in tool's
 *      `inputSchema` only uses a subset of JSON Schema Draft-07 —
 *      `type` (object/string/number/integer/boolean/array/null), `properties`,
 *      `required`, `enum`, `format` (sole allowlisted value:
 *      `web-search-freshness`), `items`, `minItems`/`maxItems`,
 *      `minimum`/`maximum` (numeric bounds), `additionalProperties`.
 *      **No** `$ref` / `allOf` / `oneOf` / `anyOf` / arbitrary `pattern`
 *      RegExp execution / `dependencies`. Auditing builtin schemas
 *      confirmed this — see `tool-schema-validator.test.ts`.
 *   2. **Zero new dependencies**: `@tabtin/agent-runtime` ships to
 *      Electron / Daemon / future mobile. ajv ≈ 60 KB minified + JIT-compiles
 *      schemas via `Function(...)` which collides with strict CSP and
 *      bundler tree-shaking expectations.
 *   3. **Predictable failure surface**: a 200-line implementation we own
 *      means error messages we can tune for **LLM self-correction**, not
 *      ajv's `should be string` shaped for human consumption.
 *
 * The validator returns structured errors with `path` + `message` +
 * `details` so the caller (FR-07 enforcement in `tool-orchestration.ts`)
 * can construct a `did_you_mean`-shaped feedback the model can act on
 * within 1–2 turns.
 *
 * **Out of scope** (deliberately): arbitrary regex `pattern`, generic
 * formats (`email` / `uri`), conditional schemas, ref resolution.
 * Unknown `format` values surface as `unsupported` (no RegExp path).
 * Schema `pattern` keys are ignored and never compiled.
 *
 * Re-validating raw model output is the **only** safety net between the
 * LLM and our `tool.execute()` — without it, `null` / wrong-type inputs
 * crash native code paths (e.g. `run_terminal_command` reading `command.trim()` on `null`).
 */

import type {
  JsonSchema,
} from '../contracts/tools.js';
import {
  WEB_SEARCH_FRESHNESS_FORMAT,
  isValidWebSearchFreshness,
} from './web-search-freshness.js';

// ─── Public Types ───────────────────────────────────────────────────

/**
 * One validation failure. Multiple errors may surface from a single
 * `validateToolInput` call — all are returned so the model can fix them
 * in a single retry instead of revealing them one at a time.
 */
export interface SchemaValidationError {
  /** Dotted JSON pointer-ish path: `''` for root, `.path`, `.items[0].name`. */
  path: string;
  /** Concise reason: `missing required field`, `wrong type`, etc. */
  message: string;
  /** Schema constraint that failed (`required` / `type` / `enum` / `format` / `minItems` / `minimum` / `additionalProperties`). */
  rule:
    | 'required'
    | 'type'
    | 'enum'
    | 'format'
    | 'minItems'
    | 'maxItems'
    | 'minimum'
    | 'maximum'
    | 'additionalProperties'
    | 'unsupported';
  /** Extra payload — `expected`, `actual`, `allowed_values`, `extra_keys`. */
  details?: Record<string, unknown>;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationError[];
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Validate `input` against a tool's `inputSchema`.
 *
 * Returns `{ valid: true, errors: [] }` when the input satisfies the
 * declared shape, otherwise `{ valid: false, errors: [...] }`. Multiple
 * errors are collected up to a hard cap (`MAX_ERRORS_PER_INPUT`) to keep
 * feedback to the LLM bounded.
 *
 * The validator is **strict on declared shape** but **lenient on
 * undeclared shape**: when a schema lacks `type` it accepts anything,
 * mirroring JSON Schema Draft-07 semantics. This avoids breaking tools
 * that intentionally accept polymorphic input (e.g. `present_to_user`'s
 * `items: { type: 'object' }` without inner properties).
 */
export function validateToolInput(
  schema: JsonSchema | undefined,
  input: unknown,
): SchemaValidationResult {
  if (!schema || typeof schema !== 'object') {
    return { valid: true, errors: [] };
  }
  const errors: SchemaValidationError[] = [];
  validateNode(input, schema, '', errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Render the first N errors as a single human-friendly suggestion line.
 * Used by `tool-orchestration.ts` to build `suggested_fix` so the model
 * gets actionable text, not just a structured array.
 *
 * Example:
 *   `Missing required field 'path'; field 'limit' must be number, got string`.
 */
export function summarizeValidationErrors(
  errors: SchemaValidationError[],
  max = 3,
): string {
  if (errors.length === 0) return '';
  const slice = errors.slice(0, max);
  const parts = slice.map((e) => formatErrorAsHint(e));
  if (errors.length > max) {
    parts.push(`(+${errors.length - max} more)`);
  }
  return parts.join('; ');
}

// ─── Internals ──────────────────────────────────────────────────────

const MAX_ERRORS_PER_INPUT = 12;
const SUPPORTED_PRIMITIVES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'null',
  'object',
  'array',
]);

function validateNode(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: SchemaValidationError[],
): void {
  if (errors.length >= MAX_ERRORS_PER_INPUT) return;

  // ─── type ──
  if (!validateDeclaredType(value, schema, path, errors)) return;

  // ─── enum ──
  if (!validateEnum(value, schema, path, errors)) return;

  // ─── string: format (allowlisted only; schema.pattern is never executed) ──
  validateStringFormat(value, schema, path, errors);

  // ─── number / integer: minimum / maximum ──
  validateNumericBounds(value, schema, path, errors);

  // ─── object: required / properties / additionalProperties ──
  validateObjectNode(value, schema, path, errors);

  // ─── array: items / minItems / maxItems ──
  validateArrayNode(value, schema, path, errors);
}

function validateDeclaredType(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: SchemaValidationError[],
): boolean {
  const declaredType = schema.type;
  if (typeof declaredType === 'string') {
    if (!SUPPORTED_PRIMITIVES.has(declaredType)) return false;
    if (matchesType(value, declaredType)) return true;
    pushTypeError(errors, path, declaredType, value);
    return false;
  }
  if (!Array.isArray(declaredType)) return true;

  const matchedAny = declaredType.some(
    (t) => typeof t === 'string' && SUPPORTED_PRIMITIVES.has(t) && matchesType(value, t),
  );
  if (matchedAny) return true;
  pushError(errors, {
    path,
    message: `expected one of [${declaredType.join(', ')}], got ${describeActual(value)}`,
    rule: 'type',
    details: { expected: declaredType, actual: describeActual(value) },
  });
  return false;
}

function pushTypeError(
  errors: SchemaValidationError[],
  path: string,
  expected: string,
  value: unknown,
): void {
  pushError(errors, {
    path,
    message: `expected ${expected}, got ${describeActual(value)}`,
    rule: 'type',
    details: { expected, actual: describeActual(value) },
  });
}

function validateEnum(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: SchemaValidationError[],
): boolean {
  if (!Array.isArray(schema.enum)) return true;
  const allowed = schema.enum as unknown[];
  if (allowed.some((v) => deepEqual(v, value))) return true;
  pushError(errors, {
    path,
    message: `value not in enum`,
    rule: 'enum',
    details: { actual: value, allowed_values: allowed },
  });
  return false;
}

/**
 * Enforce allowlisted string `format` values with linear parsers only.
 * Arbitrary JSON Schema `pattern` is intentionally ignored — compiling /
 * executing user- or schema-authored RegExp would open a sync ReDoS path
 * on the Agent main thread.
 */
function validateStringFormat(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: SchemaValidationError[],
): void {
  if (typeof value !== 'string') return;
  const format = schema.format;
  if (typeof format !== 'string') return;

  if (format === WEB_SEARCH_FRESHNESS_FORMAT) {
    if (isValidWebSearchFreshness(value)) return;
    pushError(errors, {
      path,
      message: 'string does not match required format',
      rule: 'format',
      details: { expected_format: format },
    });
    return;
  }

  pushError(errors, {
    path,
    message: `unsupported string format: ${format}`,
    rule: 'unsupported',
    details: { feature: 'format', expected_format: format },
  });
}

function validateObjectNode(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: SchemaValidationError[],
): void {
  if (!matchesType(value, 'object')) return;
  const obj = value as Record<string, unknown>;
  validateRequiredProperties(obj, schema, path, errors);

  // Empty `{}` when `properties` is omitted — still enforce
  // `additionalProperties: false` / value-schema for map-like objects
  // (e.g. shell `env: { additionalProperties: { type: 'string' } }`).
  const propsMap = getPropertiesMap(schema) ?? {};
  validateKnownProperties(obj, propsMap, path, errors);
  validateAdditionalProperties(obj, propsMap, schema, path, errors);
}

function validateRequiredProperties(
  obj: Record<string, unknown>,
  schema: JsonSchema,
  path: string,
  errors: SchemaValidationError[],
): void {
  if (!Array.isArray(schema.required)) return;
  for (const key of schema.required) {
    if (typeof key !== 'string') continue;
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) continue;
    pushError(errors, {
      path: joinPath(path, key),
      message: `missing required field`,
      rule: 'required',
      details: { field: key },
    });
  }
}

function getPropertiesMap(schema: JsonSchema): Record<string, JsonSchema> | null {
  const properties = schema.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? (properties as Record<string, JsonSchema>)
    : null;
}

function validateKnownProperties(
  obj: Record<string, unknown>,
  propsMap: Record<string, JsonSchema>,
  path: string,
  errors: SchemaValidationError[],
): void {
  for (const [key, childSchema] of Object.entries(propsMap)) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
      validateNode(obj[key], childSchema, joinPath(path, key), errors);
    }
  }
}

function validateAdditionalProperties(
  obj: Record<string, unknown>,
  propsMap: Record<string, JsonSchema>,
  schema: JsonSchema,
  path: string,
  errors: SchemaValidationError[],
): void {
  const declared = new Set(Object.keys(propsMap));
  const extras = Object.keys(obj).filter((k) => !declared.has(k));
  if (extras.length === 0) return;

  if (schema.additionalProperties === false) {
    pushError(errors, {
      path,
      message: `unexpected fields: ${extras.join(', ')}`,
      rule: 'additionalProperties',
      details: { extra_keys: extras, allowed_keys: [...declared] },
    });
    return;
  }

  // `additionalProperties: { type: 'string' }` (and other subschemas) —
  // validate each undeclared value; do not reject the key itself.
  const valueSchema = schema.additionalProperties;
  if (!valueSchema || typeof valueSchema !== 'object' || Array.isArray(valueSchema)) {
    return;
  }
  for (const key of extras) {
    validateNode(obj[key], valueSchema as JsonSchema, joinPath(path, key), errors);
  }
}

function validateArrayNode(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: SchemaValidationError[],
): void {
  if (!matchesType(value, 'array')) return;
  const arr = value as unknown[];
  validateArrayBounds(arr, schema, path, errors);

  const items = schema.items;
  if (items && typeof items === 'object' && !Array.isArray(items)) {
    arr.forEach((entry, i) => {
      validateNode(entry, items as JsonSchema, `${path}[${i}]`, errors);
    });
  }
}

function validateArrayBounds(
  arr: unknown[],
  schema: JsonSchema,
  path: string,
  errors: SchemaValidationError[],
): void {
  if (typeof schema.minItems === 'number' && arr.length < schema.minItems) {
    pushError(errors, {
      path,
      message: `array must have at least ${schema.minItems} item(s), got ${arr.length}`,
      rule: 'minItems',
      details: { expected_min: schema.minItems, actual: arr.length },
    });
  }
  if (typeof schema.maxItems === 'number' && arr.length > schema.maxItems) {
    pushError(errors, {
      path,
      message: `array must have at most ${schema.maxItems} item(s), got ${arr.length}`,
      rule: 'maxItems',
      details: { expected_max: schema.maxItems, actual: arr.length },
    });
  }
}

/**
 * Enforce JSON Schema `minimum` / `maximum` on finite numbers only.
 * Non-numbers (including strings that look numeric) are never judged here —
 * type mismatches already fail via `validateDeclaredType`, and untyped
 * schemas stay lenient for non-numeric values.
 */
function validateNumericBounds(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: SchemaValidationError[],
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;

  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    pushError(errors, {
      path,
      message: `number must be at least ${schema.minimum}, got ${value}`,
      rule: 'minimum',
      details: { expected_min: schema.minimum, actual: value },
    });
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    pushError(errors, {
      path,
      message: `number must be at most ${schema.maximum}, got ${value}`,
      rule: 'maximum',
      details: { expected_max: schema.maximum, actual: value },
    });
  }
}

function matchesType(value: unknown, declared: string): boolean {
  switch (declared) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return false;
  }
}

function describeActual(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return Number.isNaN(value) ? 'NaN' : 'Infinity';
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
}

function joinPath(parent: string, key: string): string {
  if (!parent) return key;
  return `${parent}.${key}`;
}

function pushError(
  errors: SchemaValidationError[],
  err: SchemaValidationError,
): void {
  if (errors.length >= MAX_ERRORS_PER_INPUT) return;
  errors.push(err);
}

function formatErrorAsHint(err: SchemaValidationError): string {
  const formatter = ERROR_HINT_FORMATTERS[err.rule];
  return formatter(err);
}

type ErrorHintFormatter = (err: SchemaValidationError) => string;

const ERROR_HINT_FORMATTERS: Record<SchemaValidationError['rule'], ErrorHintFormatter> = {
  required: (err) => `Missing required field '${err.path}'`,
  type: (err) => {
    const where = err.path ? `field '${err.path}'` : 'input';
    return `${where} must be ${err.details?.expected ?? 'valid type'}, got ${err.details?.actual ?? 'invalid'}`;
  },
  enum: formatEnumErrorAsHint,
  format: (err) => {
    const where = err.path ? `field '${err.path}'` : 'input';
    return `${where} must match format ${JSON.stringify(err.details?.expected_format ?? '')}`;
  },
  minItems: (err) => {
    const where = err.path ? `field '${err.path}'` : 'input';
    return `${where} must have at least ${err.details?.expected_min} item(s)`;
  },
  maxItems: (err) => {
    const where = err.path ? `field '${err.path}'` : 'input';
    return `${where} must have at most ${err.details?.expected_max} item(s)`;
  },
  minimum: (err) => {
    const where = err.path ? `field '${err.path}'` : 'input';
    return `${where} must be at least ${err.details?.expected_min}`;
  },
  maximum: (err) => {
    const where = err.path ? `field '${err.path}'` : 'input';
    return `${where} must be at most ${err.details?.expected_max}`;
  },
  additionalProperties: formatAdditionalPropertiesErrorAsHint,
  unsupported: (err) => {
    const where = err.path ? `field '${err.path}'` : 'input';
    return `${where} uses unsupported schema feature`;
  },
};

function formatEnumErrorAsHint(err: SchemaValidationError): string {
  const where = err.path ? `field '${err.path}'` : 'input';
  const allowed = err.details?.allowed_values;
  if (Array.isArray(allowed)) {
    return `${where} must be one of [${allowed.map((v) => JSON.stringify(v)).join(', ')}]`;
  }
  return `${where} has invalid enum value`;
}

function formatAdditionalPropertiesErrorAsHint(err: SchemaValidationError): string {
  const where = err.path ? `field '${err.path}'` : 'input';
  const extras = err.details?.extra_keys;
  if (Array.isArray(extras)) {
    return `${where} has unexpected fields: ${extras.join(', ')}`;
  }
  return `${where} has unexpected fields`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (Array.isArray(b)) return false;
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}

// ─── Validation Mode (FR-07 EngineConfig hookup) ────────────────────

/**
 * `EngineConfig.toolSchemaValidation` levels:
 *
 * - `'off'`   — skip validation entirely (debug / emergency rollback).
 * - `'warn'`  — validate; on failure **still execute** the tool but
 *               emit a SYSTEM_NOTICE and inject the structured errors
 *               into the tool result so the model can self-correct on
 *               the next turn. Default.
 * - `'strict'` — validate; on failure return a structured error result
 *                without invoking `tool.execute()`. Use when downstream
 *                tools have side-effects too dangerous to attempt with
 *                bad inputs (e.g. cloud deployments).
 *
 * `'warn'` is the default because many production tools are robust to
 * partially-bad input (and the model often self-corrects); jumping to
 * `'strict'` everywhere risks regressions for callers that previously
 * coerced inputs internally. See PRD §5.2 FR-07 / §6.1 Backward
 * Compatibility.
 */
export type ToolSchemaValidationLevel = 'off' | 'warn' | 'strict';

export const DEFAULT_TOOL_SCHEMA_VALIDATION: ToolSchemaValidationLevel = 'warn';

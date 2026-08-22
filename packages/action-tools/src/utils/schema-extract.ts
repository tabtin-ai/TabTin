import * as cheerio from 'cheerio';
import { extractMainContent, stripHtmlTags } from './html-content-extractor';

export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: unknown;
  required?: unknown;
  items?: unknown;
  enum?: unknown[];
  default?: unknown;
  format?: string;
  oneOf?: unknown;
  anyOf?: unknown;
};

export interface SchemaExtractInput {
  html: string;
  schema: JsonSchema;
  title?: string;
  url?: string;
}

export interface SchemaExtractResult {
  structured: unknown;
  schemaDialect: 'json-schema';
  warnings: string[];
}

type PageLink = {
  text: string;
  href: string;
};

type PageImage = {
  alt: string;
  src: string;
};

interface PageContext {
  title: string;
  url: string;
  text: string;
  lines: string[];
  meta: Map<string, string>;
  links: PageLink[];
  images: PageImage[];
}

const MAX_LINE_LENGTH = 600;
const MAX_ARRAY_ITEMS = 50;
const SUBSET_WARNING = 'schema subset: supports object/array/string/number/integer/boolean/enum/default plus oneOf/anyOf first branch; validation keywords such as pattern, minimum, maximum, minItems, maxItems, additionalProperties are ignored';
const IGNORED_SCHEMA_KEYWORDS = [
  '$schema',
  '$id',
  '$defs',
  'definitions',
  'additionalProperties',
  'pattern',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'allOf',
  'not',
  'nullable',
];

export function parseJsonSchema(schemaInput: unknown): JsonSchema {
  if (typeof schemaInput === 'string') {
    try {
      const parsed = JSON.parse(schemaInput);
      return validateJsonSchemaSubset(parsed);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON schema: ${detail}`);
    }
  }
  try {
    return validateJsonSchemaSubset(schemaInput);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON schema: ${detail}`);
  }
}

export function extractStructuredFromHtml(input: SchemaExtractInput): SchemaExtractResult {
  const schema = normalizeSchema(validateJsonSchemaSubset(input.schema));
  const page = buildPageContext(input);
  const warnings: string[] = buildSchemaSubsetWarnings(input.schema);
  const structured = extractBySchema(schema, page, warnings, []);

  return {
    structured,
    schemaDialect: 'json-schema',
    warnings,
  };
}

function validateJsonSchemaSubset(value: unknown, path = 'schema'): JsonSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`);
  }
  const schema = value as JsonSchema;

  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      throw new Error(`${path}.properties must be an object`);
    }
    for (const [key, child] of Object.entries(schema.properties as Record<string, unknown>)) {
      validateJsonSchemaSubset(child, `${path}.properties.${key}`);
    }
  }

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === 'string')) {
      throw new Error(`${path}.required must be an array of strings`);
    }
  }

  if (schema.items !== undefined) {
    if (!isPlainObject(schema.items)) {
      throw new Error(`${path}.items must be a JSON schema object`);
    }
    validateJsonSchemaSubset(schema.items, `${path}.items`);
  }

  validateBranchArray(schema.oneOf, `${path}.oneOf`);
  validateBranchArray(schema.anyOf, `${path}.anyOf`);

  return schema;
}

function validateBranchArray(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array of JSON schema objects`);
  }
  value.forEach((branch, index) => {
    if (!isPlainObject(branch)) {
      throw new Error(`${path}[${index}] must be a JSON schema object`);
    }
    validateJsonSchemaSubset(branch, `${path}[${index}]`);
  });
}

function normalizeSchema(schema: JsonSchema): JsonSchema {
  const nested = Array.isArray(schema.oneOf)
    ? schema.oneOf[0] as JsonSchema
    : Array.isArray(schema.anyOf)
      ? schema.anyOf[0] as JsonSchema
      : undefined;
  if (nested) {
    return { ...nested, title: schema.title ?? nested.title, description: schema.description ?? nested.description };
  }
  return schema;
}

function buildPageContext(input: SchemaExtractInput): PageContext {
  const $ = cheerio.load(input.html || '');
  $('script, style, noscript, svg').remove();

  const title = (input.title || $('title').first().text() || '').trim();
  const url = (input.url || '').trim();
  const meta = new Map<string, string>();
  $('meta').each((_, element) => {
    const key = ($(element).attr('property') || $(element).attr('name') || '').trim().toLowerCase();
    const value = ($(element).attr('content') || '').trim();
    if (key && value) meta.set(key, value);
  });

  const links: PageLink[] = [];
  $('a[href]').each((_, element) => {
    const href = resolveMaybeUrl($(element).attr('href') || '', url);
    const text = normalizeWhitespace($(element).text());
    if (href) links.push({ href, text });
  });

  const images: PageImage[] = [];
  $('img[src]').each((_, element) => {
    const src = resolveMaybeUrl($(element).attr('src') || '', url);
    const alt = normalizeWhitespace($(element).attr('alt') || '');
    if (src) images.push({ src, alt });
  });

  const mainHtml = extractMainContent(input.html || '', url);
  const text = stripHtmlTags(mainHtml);
  const lines = extractContentLines(mainHtml);
  const fallbackLines = text
    .split(/\r?\n|(?<=[.!?。！？])\s+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .map((line) => line.slice(0, MAX_LINE_LENGTH));

  return { title, url, text: normalizeWhitespace(text), lines: lines.length ? lines : fallbackLines, meta, links, images };
}

function extractBySchema(schemaInput: JsonSchema, page: PageContext, warnings: string[], path: string[]): unknown {
  const schema = normalizeSchema(schemaInput);
  const type = primaryType(schema);

  if (type === 'object' || schema.properties) {
    return extractObject(schema, page, warnings, path);
  }
  if (type === 'array') {
    return extractArray(schema, page, warnings, path);
  }
  return extractScalar(schema, page, warnings, path);
}

function extractObject(schema: JsonSchema, page: PageContext, warnings: string[], path: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = schemaProperties(schema);
  const required = new Set(schemaRequired(schema));

  for (const [key, childSchema] of Object.entries(properties)) {
    const childPath = [...path, key];
    const value = extractField(key, childSchema, page, warnings, childPath);
    if (value === undefined && required.has(key)) {
      result[key] = null;
      warnings.push(`missing required field: ${childPath.join('.')}`);
      continue;
    }
    result[key] = value === undefined ? null : value;
  }

  if (Object.keys(properties).length === 0) {
    warnings.push(path.length ? `object schema has no properties: ${path.join('.')}` : 'object schema has no properties');
  }

  return result;
}

function extractField(key: string, schema: JsonSchema, page: PageContext, warnings: string[], path: string[], siblingKeys: string[] = []): unknown {
  const normalized = normalizeSchema(schema);
  const type = primaryType(normalized);

  if (type === 'object' || normalized.properties) {
    return extractObject(normalized, page, warnings, path);
  }
  if (type === 'array') {
    return extractArray(normalized, page, warnings, path, key);
  }

  const raw = findFieldText(key, normalized, page, siblingKeys);
  if (raw === undefined || raw === '') {
    if (normalized.default !== undefined) return normalized.default;
    warnings.push(`no content matched field: ${path.join('.')}`);
    return undefined;
  }
  return coerceScalar(raw, normalized, warnings, path);
}

function extractArray(schema: JsonSchema, page: PageContext, warnings: string[], path: string[], key?: string): unknown[] {
  const itemSchema = normalizeSchema(schemaItems(schema));
  const itemType = primaryType(itemSchema);
  const fieldKey = key ?? last(path) ?? 'items';

  if (itemType === 'object' || itemSchema.properties) {
    return extractObjectArray(fieldKey, itemSchema, page, warnings, path);
  }

  const candidates = findArrayCandidates(fieldKey, itemSchema, page);
  const values = candidates
    .map((candidate) => coerceScalar(candidate, itemSchema, warnings, path))
    .filter((value) => value !== undefined && value !== null);

  return dedupeValues(values).slice(0, MAX_ARRAY_ITEMS);
}

function extractObjectArray(key: string, itemSchema: JsonSchema, page: PageContext, warnings: string[], path: string[]): unknown[] {
  const properties = schemaProperties(itemSchema);
  const propertyEntries = Object.entries(properties);
  if (propertyEntries.length === 0) {
    warnings.push(`array item object has no properties: ${path.join('.')}`);
    return [];
  }

  const candidates = findArrayCandidates(key, itemSchema, page);
  if (candidates.length === 0) {
    const single = extractObject(itemSchema, page, warnings, [...path, '0']);
    return Object.values(single).some((value) => value !== null && value !== undefined && value !== '') ? [single] : [];
  }

  return candidates.slice(0, MAX_ARRAY_ITEMS).map((candidate, index) => {
    const scopedPage = { ...page, text: candidate, lines: [candidate] };
    const row: Record<string, unknown> = {};
    for (const [propKey, propSchema] of propertyEntries) {
      const value = extractField(propKey, propSchema, scopedPage, warnings, [...path, String(index), propKey], propertyEntries.map(([name]) => name));
      row[propKey] = value === undefined ? null : value;
    }
    return row;
  });
}

function extractScalar(schema: JsonSchema, page: PageContext, warnings: string[], path: string[]): unknown {
  const key = last(path) ?? schema.title ?? 'value';
  const raw = findFieldText(key, schema, page);
  if (raw === undefined) return schema.default ?? null;
  return coerceScalar(raw, schema, warnings, path);
}

function findFieldText(key: string, schema: JsonSchema, page: PageContext, siblingKeys: string[] = []): string | undefined {
  const normalizedKey = normalizeKey(key);
  const labels = fieldLabels(key, schema);

  if (isUrlish(key, schema)) {
    if ((normalizedKey === 'url' || normalizedKey === 'pageurl') && page.url) return page.url;
    const link = findBestLink(labels, page);
    if (link) return link.href;
    if (normalizedKey === 'url' || normalizedKey === 'link') return page.url || undefined;
  }
  if (isImageish(key, schema)) {
    const image = findBestImage(labels, page);
    if (image) return image.src;
  }

  const direct = directPageValue(normalizedKey, page);
  if (direct) return direct;

  const metaValue = findMetaValue(labels, page);
  if (metaValue) return metaValue;

  const labeled = findLabeledValue(labels, page.lines, siblingKeys);
  if (labeled) return labeled;

  if (normalizedKey.includes('summary') || normalizedKey.includes('description')) {
    return summarize(page.text);
  }

  return undefined;
}

function findArrayCandidates(key: string, schema: JsonSchema, page: PageContext): string[] {
  const labels = fieldLabels(key, schema);
  if (isUrlish(key, schema)) return page.links.map((link) => link.href);
  if (isImageish(key, schema)) return page.images.map((image) => image.src);

  const labeled = findLabeledValue(labels, page.lines);
  if (labeled) {
    const labeledIndex = findLabeledLineIndex(labels, page.lines);
    const remainingLines = labeledIndex >= 0 ? page.lines.slice(labeledIndex + 1) : [];
    const values = [labeled, ...remainingLines].filter(Boolean);
    return values.length > 1 ? values : splitListText(labeled);
  }

  const itemType = primaryType(schema);
  if (itemType === 'number' || itemType === 'integer') {
    const matches = page.text.match(/[-+]?\d+(?:\.\d+)?/g) ?? [];
    return matches;
  }

  return page.lines.length > 1 ? page.lines : splitListText(page.text);
}

function coerceScalar(raw: string, schema: JsonSchema, warnings: string[], path: string[]): unknown {
  const text = normalizeWhitespace(raw);
  const type = primaryType(schema);

  if (schema.enum?.length) {
    const exact = schema.enum.find((candidate) => normalizeWhitespace(String(candidate)).toLowerCase() === text.toLowerCase());
    if (exact !== undefined) return exact;
    const fuzzy = schema.enum.find((candidate) => text.toLowerCase().includes(normalizeWhitespace(String(candidate)).toLowerCase()));
    if (fuzzy !== undefined) return fuzzy;
    warnings.push(`value did not match enum at ${path.join('.')}: ${text}`);
    return null;
  }

  if (type === 'number' || type === 'integer') {
    const match = text.match(/[-+]?\d+(?:\.\d+)?/);
    if (!match) {
      warnings.push(`could not coerce number at ${path.join('.')}: ${text}`);
      return null;
    }
    const num = Number(match[0]);
    return type === 'integer' ? Math.trunc(num) : num;
  }
  if (type === 'boolean') {
    if (/^(true|yes|y|1|是|有)$/i.test(text)) return true;
    if (/^(false|no|n|0|否|无)$/i.test(text)) return false;
    warnings.push(`could not coerce boolean at ${path.join('.')}: ${text}`);
    return null;
  }

  return text;
}

function primaryType(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) {
    return schema.type.find((type) => type !== 'null') ?? schema.type[0] ?? 'string';
  }
  if (schema.type) return schema.type;
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return 'string';
}

function schemaProperties(schema: JsonSchema): Record<string, JsonSchema> {
  return isPlainObject(schema.properties) ? schema.properties as Record<string, JsonSchema> : {};
}

function schemaRequired(schema: JsonSchema): string[] {
  return Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];
}

function schemaItems(schema: JsonSchema): JsonSchema {
  return isPlainObject(schema.items) ? schema.items as JsonSchema : { type: 'string' };
}

function fieldLabels(key: string, schema: JsonSchema): string[] {
  return [key, schema.title, schema.description]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalizeLabel(value));
}

function normalizeLabel(value: string): string {
  return normalizeWhitespace(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b(url|uri|href|src|text|field|字段)\b/gi, '')
    .trim();
}

function normalizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '').toLowerCase();
}

function directPageValue(key: string, page: PageContext): string | undefined {
  if (key === 'title' || key === 'name') return page.title || undefined;
  if (key === 'url' || key === 'href' || key === 'link') return page.url || undefined;
  return undefined;
}

function findMetaValue(labels: string[], page: PageContext): string | undefined {
  for (const [key, value] of page.meta.entries()) {
    const normalized = normalizeKey(key);
    if (labels.some((label) => normalized.includes(normalizeKey(label)))) return value;
  }
  return undefined;
}

function findLabeledValue(labels: string[], lines: string[], siblingKeys: string[] = []): string | undefined {
  for (const line of lines) {
    for (const label of labels) {
      const escaped = escapeRegExp(label);
      const match = line.match(new RegExp(`(?:^|\\b)${escaped}\\s*[:：\\-]\\s*(.+)$`, 'i'));
      if (match?.[1]) return trimAtSiblingLabel(match[1].trim(), label, siblingKeys);
    }
  }
  return undefined;
}

function findLabeledLineIndex(labels: string[], lines: string[]): number {
  return lines.findIndex((line) => labels.some((label) => {
    const escaped = escapeRegExp(label);
    return new RegExp(`(?:^|\\b)${escaped}\\s*[:：\\-]\\s*`, 'i').test(line);
  }));
}

function findBestLink(labels: string[], page: PageContext): PageLink | undefined {
  return page.links.find((link) => labels.some((label) => normalizeKey(link.text).includes(normalizeKey(label))))
    ?? page.links[0];
}

function findBestImage(labels: string[], page: PageContext): PageImage | undefined {
  return page.images.find((image) => labels.some((label) => normalizeKey(image.alt).includes(normalizeKey(label))))
    ?? page.images[0];
}

function isUrlish(key: string, schema: JsonSchema): boolean {
  const probe = `${key} ${schema.title ?? ''} ${schema.description ?? ''} ${schema.format ?? ''}`.toLowerCase();
  return /\b(url|uri|href|link)\b/.test(probe);
}

function isImageish(key: string, schema: JsonSchema): boolean {
  const probe = `${key} ${schema.title ?? ''} ${schema.description ?? ''} ${schema.format ?? ''}`.toLowerCase();
  return /\b(image|img|photo|picture|thumbnail|src)\b/.test(probe);
}

function splitListText(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/\s*(?:,|，|;|；|\||、|\n)\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractContentLines(html: string): string[] {
  const $ = cheerio.load(html || '');
  const lines: string[] = [];
  const seen = new Set<string>();
  $('h1,h2,h3,h4,h5,h6,p,li,dt,dd,th,td,figcaption,blockquote').each((_, element) => {
    const line = normalizeWhitespace($(element).text()).slice(0, MAX_LINE_LENGTH);
    if (!line || seen.has(line)) return;
    seen.add(line);
    lines.push(line);
  });
  return lines;
}

function summarize(text: string): string {
  const normalized = normalizeWhitespace(text);
  return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
}

function dedupeValues(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function resolveMaybeUrl(value: string, baseUrl: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return baseUrl ? new URL(trimmed, baseUrl).href : trimmed;
  } catch {
    return trimmed;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function last<T>(values: T[]): T | undefined {
  return values[values.length - 1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimAtSiblingLabel(value: string, currentLabel: string, siblingKeys: string[]): string {
  let end = value.length;
  const current = normalizeKey(currentLabel);
  for (const sibling of siblingKeys) {
    if (normalizeKey(sibling) === current) continue;
    const match = value.match(new RegExp(`\\b${escapeRegExp(sibling)}\\s*[:：\\-]`, 'i'));
    if (match?.index !== undefined && match.index > 0) {
      end = Math.min(end, match.index);
    }
  }
  return value.slice(0, end).trim();
}

function buildSchemaSubsetWarnings(schema: JsonSchema): string[] {
  const warnings = [SUBSET_WARNING];
  collectIgnoredKeywordWarnings(schema, 'schema', warnings);
  return warnings;
}

function collectIgnoredKeywordWarnings(schema: JsonSchema, path: string, warnings: string[]): void {
  for (const key of Object.keys(schema)) {
    if (IGNORED_SCHEMA_KEYWORDS.includes(key)) {
      warnings.push(`schema keyword ignored at ${path}.${key}`);
    }
  }

  for (const [key, child] of Object.entries(schemaProperties(schema))) {
    collectIgnoredKeywordWarnings(child, `${path}.properties.${key}`, warnings);
  }

  if (schema.items) {
    collectIgnoredKeywordWarnings(schemaItems(schema), `${path}.items`, warnings);
  }

  for (const branchKey of ['oneOf', 'anyOf'] as const) {
    const branches = schema[branchKey];
    if (!Array.isArray(branches)) continue;
    if (branches.length > 1) {
      warnings.push(`${path}.${branchKey}: only the first branch is used by schema extract subset`);
    }
    branches.forEach((branch, index) => collectIgnoredKeywordWarnings(branch as JsonSchema, `${path}.${branchKey}[${index}]`, warnings));
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

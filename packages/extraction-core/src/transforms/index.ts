import type { ExtractionSchema } from '@tabtin/crawl-contracts';

type ExtractionField = ExtractionSchema['fields'][number];
type TransformDef = NonNullable<ExtractionField['transform']>;
type ArrayTransformDef = NonNullable<ExtractionField['array_transform']>;

export function applyTransform(value: unknown, t: TransformDef): unknown {
  let r = value;

  if (t.trim && typeof r === 'string') {
    r = r.trim();
  }

  if (t.replace && typeof r === 'string') {
    r = r.replace(new RegExp(t.replace.pattern, 'g'), t.replace.replacement);
  }

  if (t.substring && typeof r === 'string') {
    r = r.substring(t.substring[0], t.substring[1]);
  }

  if (t.match_all && typeof r === 'string') {
    r = r.match(new RegExp(t.match_all, 'g')) ?? [];
  }

  if (t.split && typeof r === 'string') {
    r = r.split(t.split);
  }

  if (t.pad_start && typeof r === 'string') {
    r = r.padStart(t.pad_start[0], t.pad_start[1]);
  }

  if (t.pad_end && typeof r === 'string') {
    r = r.padEnd(t.pad_end[0], t.pad_end[1]);
  }

  if (t.to_number) {
    const num = Number(r);
    if (!isNaN(num)) r = num;
  }

  if (t.to_date && typeof r === 'string') {
    const date = new Date(r);
    if (!isNaN(date.getTime())) r = date.toISOString();
  }

  return r;
}

export function applyArrayTransform(
  values: unknown[],
  t: ArrayTransformDef,
): unknown[] | string {
  let r = [...values];

  if (t.filter_empty) {
    r = r.filter(v => v !== null && v !== undefined && v !== '');
  }

  if (t.unique) {
    r = [...new Set(r)];
  }

  if (t.sort) {
    const asc = t.sort === 'asc';
    r.sort((a, b) =>
      asc
        ? String(a).localeCompare(String(b))
        : String(b).localeCompare(String(a)),
    );
  }

  if (t.slice) {
    r = r.slice(t.slice[0], t.slice[1]);
  }

  if (t.limit !== undefined) {
    r = r.slice(0, t.limit);
  }

  if (t.join !== undefined) {
    return r.join(t.join);
  }

  return r;
}

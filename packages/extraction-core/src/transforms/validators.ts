import type { ExtractionSchema } from '@tabtin/crawl-contracts';

type ExtractionField = ExtractionSchema['fields'][number];
type ValidationDef = NonNullable<ExtractionField['validation']>;

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validate(value: unknown, rules: ValidationDef): ValidationResult {
  if (rules.required && (value === null || value === undefined || value === '')) {
    return fail(rules, 'Field is required');
  }

  if (value === null || value === undefined) return { valid: true };

  if (rules.min_length !== undefined && typeof value === 'string' && value.length < rules.min_length) {
    return fail(rules, `Minimum length: ${rules.min_length}`);
  }

  if (rules.max_length !== undefined && typeof value === 'string' && value.length > rules.max_length) {
    return fail(rules, `Maximum length: ${rules.max_length}`);
  }

  if (rules.min !== undefined && typeof value === 'number' && value < rules.min) {
    return fail(rules, `Minimum value: ${rules.min}`);
  }

  if (rules.max !== undefined && typeof value === 'number' && value > rules.max) {
    return fail(rules, `Maximum value: ${rules.max}`);
  }

  if (rules.regex && !new RegExp(rules.regex).test(String(value))) {
    return fail(rules, `Does not match pattern: ${rules.regex}`);
  }

  if (rules.enum && !rules.enum.includes(value)) {
    return fail(rules, `Must be one of: ${rules.enum.join(', ')}`);
  }

  return { valid: true };
}

function fail(rules: ValidationDef, defaultMsg: string): ValidationResult {
  return { valid: false, error: rules.error_message ?? defaultMsg };
}

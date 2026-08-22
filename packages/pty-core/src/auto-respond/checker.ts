import type { AutoRespondRule, AutoRespondMatch } from './types';
import { MARKER_PREFIX, AUTO_RESPOND_MAX_RESPONSE_LENGTH } from '../marker/constants';

/**
 * Validates an auto-respond rule before use.
 * Returns an error message if invalid, or null if valid.
 */
export function validateAutoRespondRule(rule: AutoRespondRule): string | null {
  if (!rule.pattern || rule.pattern.trim().length === 0) {
    return 'pattern must not be empty';
  }
  if (rule.response.length > AUTO_RESPOND_MAX_RESPONSE_LENGTH) {
    return `response exceeds maximum length of ${AUTO_RESPOND_MAX_RESPONSE_LENGTH} characters`;
  }
  if (rule.response.includes(MARKER_PREFIX)) {
    return 'response must not contain marker prefix';
  }
  return null;
}

/**
 * Pure function: checks whether `output` matches any of the `rules`.
 * Returns the first match found, with the response string already
 * unescaped (\\n → \n, \\r → \r, \\t → \t).
 *
 * Rules with empty patterns, responses exceeding 1024 chars, or responses
 * containing the marker prefix are silently skipped (PC-4/PC-5 fix).
 */
export function checkAutoRespond(
  output: string,
  rules: AutoRespondRule[],
): AutoRespondMatch {
  if (!output || rules.length === 0) {
    return { matched: false };
  }

  const lowerOutput = output.toLowerCase();

  for (const rule of rules) {
    // Skip invalid rules (PC-4: empty pattern, PC-5: dangerous response)
    if (validateAutoRespondRule(rule) !== null) continue;

    if (lowerOutput.includes(rule.pattern.toLowerCase())) {
      const response = rule.response
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t');
      return { matched: true, response };
    }
  }

  return { matched: false };
}

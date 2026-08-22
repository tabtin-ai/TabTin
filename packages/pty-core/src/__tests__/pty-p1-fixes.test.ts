import { describe, it, expect } from 'vitest';
import { checkAutoRespond } from '../auto-respond/checker';
import type { AutoRespondRule } from '../auto-respond/types';

describe('PTY-003: auto-respond shared module', () => {
  it('returns { matched: false } when no rules match', () => {
    const rules: AutoRespondRule[] = [
      { pattern: 'continue?', response: 'y\n' },
    ];
    const result = checkAutoRespond('some unrelated output', rules);
    expect(result.matched).toBe(false);
    expect(result.response).toBeUndefined();
  });

  it('matches case-insensitively and returns unescaped response', () => {
    const rules: AutoRespondRule[] = [
      { pattern: 'Do you want to continue?', response: 'yes\\n' },
    ];
    const result = checkAutoRespond(
      'WARNING: do you want to CONTINUE? [y/N]',
      rules,
    );
    expect(result.matched).toBe(true);
    expect(result.response).toBe('yes\n');
  });

  it('returns the first matching rule', () => {
    const rules: AutoRespondRule[] = [
      { pattern: 'first', response: 'response-1' },
      { pattern: 'second', response: 'response-2' },
    ];
    const output = 'this has first and second';
    const result = checkAutoRespond(output, rules);
    expect(result.matched).toBe(true);
    expect(result.response).toBe('response-1');
  });

  it('handles empty output', () => {
    const rules: AutoRespondRule[] = [
      { pattern: 'anything', response: 'resp' },
    ];
    expect(checkAutoRespond('', rules).matched).toBe(false);
  });

  it('handles empty rules array', () => {
    expect(checkAutoRespond('some output', []).matched).toBe(false);
  });

  it('skips rules with empty pattern', () => {
    const rules: AutoRespondRule[] = [
      { pattern: '', response: 'never' },
      { pattern: 'real', response: 'found' },
    ];
    const result = checkAutoRespond('real output', rules);
    expect(result.matched).toBe(true);
    expect(result.response).toBe('found');
  });

  it('unescapes \\r and \\t in response', () => {
    const rules: AutoRespondRule[] = [
      { pattern: 'prompt', response: 'val\\r\\n\\tend' },
    ];
    const result = checkAutoRespond('prompt here', rules);
    expect(result.response).toBe('val\r\n\tend');
  });
});

describe('PTY-003: auto-respond module exports from pty-core index', () => {
  it('checkAutoRespond is re-exported from package entry', async () => {
    const mod = await import('../index');
    expect(typeof mod.checkAutoRespond).toBe('function');
  });
});

describe('PTY-007: tsconfig.json composite flag', () => {
  it('tsconfig.json contains composite: true', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const tsconfig = JSON.parse(
      readFileSync(resolve(__dirname, '..', '..', 'tsconfig.json'), 'utf-8'),
    );
    expect(tsconfig.compilerOptions.composite).toBe(true);
  });

  it('tsconfig.build.json extends tsconfig.json with composite: false', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const buildConfig = JSON.parse(
      readFileSync(resolve(__dirname, '..', '..', 'tsconfig.build.json'), 'utf-8'),
    );
    expect(buildConfig.extends).toBe('./tsconfig.json');
    expect(buildConfig.compilerOptions.composite).toBe(false);
  });
});

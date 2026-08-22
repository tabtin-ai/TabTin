import { describe, expect, it } from 'vitest';
import { shouldUseLocalCodexProvider } from '../openai-codex-provider-selection.js';

describe('shouldUseLocalCodexProvider', () => {
  it('recognizes a model declared by the local Codex catalog', () => {
    expect(shouldUseLocalCodexProvider('gpt-5.6-sol')).toBe(true);
  });

  it('keeps non-Codex models on the platform provider path', () => {
    expect(shouldUseLocalCodexProvider('gpt-4.1')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { redactSecretsInOutput } from '../_redact.js';

describe('redactSecretsInOutput', () => {
  it('redacts literal secret values in stdout', () => {
    const secret = 'ghp_secretXYZ';
    const output = redactSecretsInOutput(`token=${secret}`, {
      GITHUB_TOKEN: secret,
    });
    expect(output).not.toContain(secret);
    expect(output).toContain('***REDACTED***');
  });

  it('redacts base64-encoded secret values in stdout', () => {
    const secret = 'sk-long-enough-key';
    const encoded = Buffer.from(secret, 'utf8').toString('base64');
    const output = redactSecretsInOutput(`Authorization: Bearer ${encoded}`, {
      OPENAI_API_KEY: secret,
    });
    expect(output).not.toContain(encoded);
    expect(output).toContain('***REDACTED***');
  });
});

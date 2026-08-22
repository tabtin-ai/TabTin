import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFetchFailureEnvelope, buildFetchSuccessEnvelope } from './fetch.js';

describe('fetch route envelopes', () => {
  it('buildFetchFailureEnvelope returns ok:false with FETCH_FAILED code', () => {
    const envelope = buildFetchFailureEnvelope('https://blocked.example.com', {
      error: '[blocked] — Access denied (HTTP 403)',
      quality: {
        ok: false,
        reason: 'blocked',
        message: 'Access denied (HTTP 403)',
        suggestion: 'Use `tabtin browser open <url>` to load in a real browser.',
      },
    });

    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'FETCH_FAILED');
    assert.match(envelope.error.message, /Access denied/);
    assert.deepEqual(envelope.error.suggestions, [
      'Use `tabtin browser open <url>` to load in a real browser.',
    ]);
    assert.equal((envelope.error.detail as { url?: string }).url, 'https://blocked.example.com');
  });

  it('buildFetchSuccessEnvelope returns ok:true with content payload', () => {
    const envelope = buildFetchSuccessEnvelope({
      content: 'Hello world from example.com page content.',
      title: 'Example',
      url: 'https://example.com',
      quality: { ok: true },
      fallbackUsed: 'none',
    });

    assert.equal(envelope.ok, true);
    assert.equal((envelope.data as { content?: string }).content, 'Hello world from example.com page content.');
    assert.equal((envelope.data as { fallback_used?: string }).fallback_used, 'none');
  });

  it('buildFetchSuccessEnvelope surfaces full_content_path when truncated', () => {
    const envelope = buildFetchSuccessEnvelope({
      content: 'head chunk [... truncated at 20 of 500000 chars ...]',
      title: 'Big JSON',
      url: 'https://data.sec.gov/submissions/CIK0001318605.json',
      quality: { ok: true },
      fallbackUsed: 'none',
      truncated: true,
      contentLength: 500000,
      fullContentPath: '/tmp/tabtin-fetch-results/fetch-abc.txt',
    });

    const data = envelope.data as {
      truncated?: boolean;
      content_length?: number;
      full_content_path?: string;
    };
    assert.equal(envelope.ok, true);
    assert.equal(data.truncated, true);
    assert.equal(data.content_length, 500000);
    assert.equal(data.full_content_path, '/tmp/tabtin-fetch-results/fetch-abc.txt');
  });

  it('buildFetchSuccessEnvelope omits truncation fields when not truncated', () => {
    const envelope = buildFetchSuccessEnvelope({
      content: 'short',
      title: 'Small',
      url: 'https://example.com',
      quality: { ok: true },
      fallbackUsed: 'none',
    });

    const data = envelope.data as Record<string, unknown>;
    assert.equal('truncated' in data, false);
    assert.equal('full_content_path' in data, false);
    assert.equal('content_length' in data, false);
  });
});

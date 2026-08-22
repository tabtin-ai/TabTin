import { describe, it, expect } from 'vitest';
import {
  validateNavigationUrl,
  validateUrl,
  isAllowedScheme,
} from '../url-validator';

// ---------------------------------------------------------------------------
// validateNavigationUrl
// ---------------------------------------------------------------------------
describe('validateNavigationUrl', () => {
  describe('valid URLs → ok', () => {
    it.each(['https://example.com', 'http://example.com'])(
      '%s passes',
      (url) => {
        expect(validateNavigationUrl(url)).toEqual({ ok: true });
      },
    );

    it('about:blank passes', () => {
      expect(validateNavigationUrl('about:blank')).toEqual({ ok: true });
    });
  });

  describe('blocked schemes', () => {
    it.each([
      ['ftp://example.com', 'ftp:'],
      ['file:///etc/passwd', 'file:'],
      ['javascript:alert(1)', 'javascript:'],
    ])('%s → blocked (%s)', (url, scheme) => {
      const result = validateNavigationUrl(url);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(scheme);
    });
  });

  describe('custom allowedProtocols', () => {
    it('allows about: when included in allowedProtocols', () => {
      const result = validateNavigationUrl('about:srcdoc', {
        allowedProtocols: new Set(['http:', 'https:', 'about:']),
      });
      expect(result.ok).toBe(true);
    });

    it('still blocks unlisted protocols with custom set', () => {
      const result = validateNavigationUrl('ftp://example.com', {
        allowedProtocols: new Set(['http:', 'https:', 'about:']),
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('userinfo blocking', () => {
    it('blocks http://user:pass@example.com', () => {
      const result = validateNavigationUrl('http://user:pass@example.com');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('userinfo');
    });
  });

  describe('private host blocking', () => {
    it.each([
      'http://127.0.0.1',
      'http://metadata.google.internal',
      'http://10.0.0.1',
      'http://localhost',
    ])('%s → blocked', (url) => {
      const result = validateNavigationUrl(url);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('private');
    });
  });

  describe('invalid / empty URLs', () => {
    it('invalid URL returns error', () => {
      const result = validateNavigationUrl('not-a-url');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Invalid URL');
    });

    it('empty string returns ok (falsy guard)', () => {
      expect(validateNavigationUrl('')).toEqual({ ok: true });
    });

    it('null-ish (undefined) returns ok', () => {
      expect(validateNavigationUrl(undefined as unknown as string)).toEqual({
        ok: true,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// validateUrl
// ---------------------------------------------------------------------------
describe('validateUrl', () => {
  it('does not throw for valid public URL', () => {
    expect(() => validateUrl('https://example.com')).not.toThrow();
  });

  it('throws for disallowed protocol', () => {
    expect(() => validateUrl('ftp://example.com')).toThrow(/不允许的 URL 协议/);
  });

  it('throws for userinfo', () => {
    expect(() => validateUrl('http://user:pass@example.com')).toThrow(
      /用户信息/,
    );
  });

  it('throws for private host', () => {
    expect(() => validateUrl('http://127.0.0.1')).toThrow(/SSRF/);
  });

  it('throws for invalid URL', () => {
    expect(() => validateUrl('not-a-url')).toThrow(/无效的 URL/);
  });
});

// ---------------------------------------------------------------------------
// isAllowedScheme
// ---------------------------------------------------------------------------
describe('isAllowedScheme', () => {
  describe('default allowed schemes', () => {
    it.each(['http://example.com', 'https://example.com'])(
      '%s → true',
      (url) => {
        expect(isAllowedScheme(url)).toBe(true);
      },
    );
  });

  describe('blocked schemes by default', () => {
    it.each(['ftp://example.com', 'file:///etc/passwd'])(
      '%s → false',
      (url) => {
        expect(isAllowedScheme(url)).toBe(false);
      },
    );
  });

  describe('extraProtocols', () => {
    it('allows ftp: when listed in extraProtocols', () => {
      expect(isAllowedScheme('ftp://example.com', ['ftp:'])).toBe(true);
    });
  });

  describe('about:blank special case', () => {
    it('about:blank → true', () => {
      expect(isAllowedScheme('about:blank')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('empty string → true (falsy guard)', () => {
      expect(isAllowedScheme('')).toBe(true);
    });

    it('invalid URL → false', () => {
      expect(isAllowedScheme('not-a-url')).toBe(false);
    });
  });
});

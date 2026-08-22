/**
 * 交叉一致性测试：确保 pty-core 和 terminal-core 两份 sanitizeEnv
 * 导出的安全变量列表来自同一个包 (@tabtin/env-sanitize)。
 *
 * 由于两边都已改为从 @tabtin/env-sanitize re-export，
 * 这里验证两边导出的是同一个引用对象。
 */
import { describe, it, expect } from 'vitest';

import {
  DANGEROUS_INJECTION_VARS as TC_DANGEROUS,
  SENSITIVE_ENV_VARS as TC_SENSITIVE,
  SENSITIVE_PATTERNS as TC_PATTERNS,
  SAFE_ALLOWLIST as TC_ALLOWLIST,
  sanitizeEnv as tcSanitizeEnv,
  isSensitiveByPattern as tcIsSensitiveByPattern,
} from '../src/sanitizeEnv';

import {
  DANGEROUS_INJECTION_VARS as PTY_DANGEROUS,
  SENSITIVE_ENV_VARS as PTY_SENSITIVE,
  SENSITIVE_PATTERNS as PTY_PATTERNS,
  SAFE_ALLOWLIST as PTY_ALLOWLIST,
  sanitizeEnv as ptySanitizeEnv,
  isSensitiveByPattern as ptyIsSensitiveByPattern,
} from '../../pty-core/src/utils/sanitize-env';

describe('pty-core ↔ terminal-core sanitizeEnv 交叉一致性', () => {
  it('DANGEROUS_INJECTION_VARS 是同一个引用', () => {
    expect(TC_DANGEROUS).toBe(PTY_DANGEROUS);
  });

  it('SENSITIVE_ENV_VARS 是同一个引用', () => {
    expect(TC_SENSITIVE).toBe(PTY_SENSITIVE);
  });

  it('SENSITIVE_PATTERNS 是同一个引用', () => {
    expect(TC_PATTERNS).toBe(PTY_PATTERNS);
  });

  it('SAFE_ALLOWLIST 是同一个引用', () => {
    expect(TC_ALLOWLIST).toBe(PTY_ALLOWLIST);
  });

  it('sanitizeEnv 是同一个函数引用', () => {
    expect(tcSanitizeEnv).toBe(ptySanitizeEnv);
  });

  it('isSensitiveByPattern 是同一个函数引用', () => {
    expect(tcIsSensitiveByPattern).toBe(ptyIsSensitiveByPattern);
  });
});

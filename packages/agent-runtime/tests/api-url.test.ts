/**
 * `utils/api-url.ts` 行为契约单测。
 *
 * 这层 helper 是 agent-runtime 内部 zero-dep 的 URL 拼接工具，行为必须与
 * `@tabtin/config` 的 `joinApiPath` 完全一致——避免两份实现漂移导致历史
 * "双 /api" bug 重新冒头。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { joinApiPath } from '../src/utils/api-url.js';

describe('agent-runtime utils/api-url · joinApiPath', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  it('正常路径直接拼接（path 以 / 开头）', () => {
    expect(joinApiPath('http://localhost:6060/api', '/plan/create')).toBe(
      'http://localhost:6060/api/plan/create',
    );
  });

  it('path 不以 / 开头时自动补斜杠', () => {
    expect(joinApiPath('http://localhost:6060/api', 'plan/create')).toBe(
      'http://localhost:6060/api/plan/create',
    );
  });

  it('空 path 时不补斜杠（保持 base 原样）', () => {
    expect(joinApiPath('http://localhost:6060/api', '')).toBe(
      'http://localhost:6060/api',
    );
  });

  it('path 错误以 /api 开头时自动剥离前缀', () => {
    process.env.NODE_ENV = 'production';
    expect(
      joinApiPath('http://localhost:6060/api', '/api/plan/create'),
    ).toBe('http://localhost:6060/api/plan/create');
  });

  it('path 等于 /api 时也能正确剥离', () => {
    process.env.NODE_ENV = 'production';
    expect(joinApiPath('http://localhost:6060/api', '/api')).toBe(
      'http://localhost:6060/api',
    );
  });

  it('dev 环境下 path 以 /api 开头会打 console.warn', () => {
    process.env.NODE_ENV = 'development';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    joinApiPath('http://localhost:6060/api', '/api/plan/create');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('[agent-runtime joinApiPath]');
    expect(message).toContain('/api/plan/create');
    expect(message).toContain('请直接使用不含 /api 前缀的路径');
  });

  it('production 环境下不打 warn（保持安静）', () => {
    process.env.NODE_ENV = 'production';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    joinApiPath('http://localhost:6060/api', '/api/plan/create');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('正常 path（不含 /api 前缀）即使在 dev 也不打 warn', () => {
    process.env.NODE_ENV = 'development';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    joinApiPath('http://localhost:6060/api', '/plan/create');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('path 含 /api 子串但不在开头时不剥离（防止误伤）', () => {
    expect(
      joinApiPath('http://localhost:6060/api', '/services/api-key/list'),
    ).toBe('http://localhost:6060/api/services/api-key/list');
  });

  it('path 以 /apixxx 开头时不剥离（边界：必须是完整 /api 段）', () => {
    expect(
      joinApiPath('http://localhost:6060/api', '/apiblahblah'),
    ).toBe('http://localhost:6060/api/apiblahblah');
  });
});

/**
 * isNativeBackendSessionEnabled feature flag（ Stage 6d 随 bootstrap 迁入）。
 */

import { describe, expect, it } from 'vitest';
import { isNativeBackendSessionEnabled } from '../../src/native/host-bootstrap.js';

describe('isNativeBackendSessionEnabled feature flag', () => {
  it('undefined / 空串默认开启', () => {
    expect(isNativeBackendSessionEnabled(undefined)).toBe(true);
    expect(isNativeBackendSessionEnabled('')).toBe(true);
    expect(isNativeBackendSessionEnabled('   ')).toBe(true);
  });

  it('disabled 系取值关闭', () => {
    expect(isNativeBackendSessionEnabled('disabled')).toBe(false);
    expect(isNativeBackendSessionEnabled('0')).toBe(false);
    expect(isNativeBackendSessionEnabled('false')).toBe(false);
    expect(isNativeBackendSessionEnabled('off')).toBe(false);
    expect(isNativeBackendSessionEnabled('no')).toBe(false);
    expect(isNativeBackendSessionEnabled('n')).toBe(false);
    expect(isNativeBackendSessionEnabled('FALSE')).toBe(false);
    expect(isNativeBackendSessionEnabled(' off ')).toBe(false);
  });

  it('其他显式值仍开启', () => {
    expect(isNativeBackendSessionEnabled('enabled')).toBe(true);
    expect(isNativeBackendSessionEnabled('1')).toBe(true);
    expect(isNativeBackendSessionEnabled('on')).toBe(true);
    expect(isNativeBackendSessionEnabled('yes')).toBe(true);
  });
});

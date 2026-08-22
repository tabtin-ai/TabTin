import { describe, expect, it } from 'vitest';
import {
  isViewFullyLoaded,
  resolveShouldUseServerSearch,
} from './serverSearchGating';

describe('isViewFullyLoaded', () => {
  it('treats empty/unknown total as fully loaded', () => {
    expect(isViewFullyLoaded(0, 0)).toBe(true);
    expect(isViewFullyLoaded(0, -1)).toBe(true);
  });

  it('returns false when loaded is below total', () => {
    expect(isViewFullyLoaded(200, 994)).toBe(false);
  });

  it('returns true when loaded reaches total', () => {
    expect(isViewFullyLoaded(994, 994)).toBe(true);
    expect(isViewFullyLoaded(1000, 994)).toBe(true);
  });
});

describe('resolveShouldUseServerSearch', () => {
  const base = {
    supported: true,
    enabled: false,
    abnormalCount: 0,
    loadedRecordCount: 0,
    totalRecordCount: 0,
  };

  it('is false when search index is unsupported', () => {
    expect(
      resolveShouldUseServerSearch({ ...base, supported: false }),
    ).toBe(false);
  });

  it('is false when index has abnormalities', () => {
    expect(
      resolveShouldUseServerSearch({ ...base, abnormalCount: 2 }),
    ).toBe(false);
  });

  it('is true when index is enabled regardless of load state', () => {
    expect(
      resolveShouldUseServerSearch({
        ...base,
        enabled: true,
        loadedRecordCount: 994,
        totalRecordCount: 994,
      }),
    ).toBe(true);
  });

  it('is true for a large table not fully loaded even without index', () => {
    expect(
      resolveShouldUseServerSearch({
        ...base,
        enabled: false,
        loadedRecordCount: 200,
        totalRecordCount: 994,
      }),
    ).toBe(true);
  });

  it('is false for a small fully-loaded table without index', () => {
    expect(
      resolveShouldUseServerSearch({
        ...base,
        enabled: false,
        loadedRecordCount: 50,
        totalRecordCount: 50,
      }),
    ).toBe(false);
  });

  it('is false when status fields are undefined', () => {
    expect(
      resolveShouldUseServerSearch({
        supported: undefined,
        enabled: undefined,
        abnormalCount: undefined,
        loadedRecordCount: 200,
        totalRecordCount: 994,
      }),
    ).toBe(false);
  });
});

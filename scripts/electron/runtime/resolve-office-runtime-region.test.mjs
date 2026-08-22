import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveOfficeRuntimeRegion } from './resolve-office-runtime-region.mjs';

test('explicit Office runtime region overrides local address hints', () => {
  assert.equal(
    resolveOfficeRuntimeRegion({
      requested: 'global',
      locale: 'zh-CN',
      timeZone: 'Asia/Shanghai',
    }),
    'global',
  );
  assert.equal(
    resolveOfficeRuntimeRegion({
      requested: 'cn',
      locale: 'en-US',
      timeZone: 'America/Los_Angeles',
    }),
    'cn',
  );
});

test('auto region recognizes China locale or time zone', () => {
  assert.equal(
    resolveOfficeRuntimeRegion({
      requested: 'auto',
      locale: 'zh-CN',
      timeZone: 'UTC',
    }),
    'cn',
  );
  assert.equal(
    resolveOfficeRuntimeRegion({
      requested: 'auto',
      locale: 'en-US',
      timeZone: 'Asia/Shanghai',
    }),
    'cn',
  );
});

test('auto region defaults non-China addresses to global', () => {
  assert.equal(
    resolveOfficeRuntimeRegion({
      requested: 'auto',
      locale: 'en-US',
      timeZone: 'America/Los_Angeles',
    }),
    'global',
  );
});

test('invalid explicit region is rejected', () => {
  assert.throws(
    () => resolveOfficeRuntimeRegion({ requested: 'nearby' }),
    /expected auto, cn, or global/,
  );
});

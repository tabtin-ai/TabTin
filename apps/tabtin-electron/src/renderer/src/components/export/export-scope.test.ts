import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  resolveCurrentViewRecordCount,
  resolveExportFieldsForScope,
  shouldApplyCurrentViewQuery,
} from './export-scope';

const allFields = ['title', 'status', 'hidden-notes'];
const visibleViewFields = ['title', 'status'];

test('all-record export keeps all table fields and ignores the current query', () => {
  assert.deepEqual(
    resolveExportFieldsForScope('all', allFields, visibleViewFields),
    allFields,
  );
  assert.equal(shouldApplyCurrentViewQuery('all'), false);
});

test('selected-record export keeps all table fields and ignores the current query', () => {
  assert.deepEqual(
    resolveExportFieldsForScope('selected', allFields, visibleViewFields),
    allFields,
  );
  assert.equal(shouldApplyCurrentViewQuery('selected'), false);
});

test('current-view export uses visible fields and applies the current query', () => {
  assert.deepEqual(
    resolveExportFieldsForScope('view', allFields, visibleViewFields),
    visibleViewFields,
  );
  assert.equal(shouldApplyCurrentViewQuery('view'), true);
});

test('current-view matched count wins over stale export stats', () => {
  assert.equal(resolveCurrentViewRecordCount(6, 6, 9), 6);
  assert.equal(resolveCurrentViewRecordCount(undefined, 6, 9), 6);
  assert.equal(resolveCurrentViewRecordCount(undefined, undefined, 9), 9);
});

test('matched view count wins over currently rendered rows', () => {
  assert.equal(resolveCurrentViewRecordCount(100, 100, 100, 50), 100);
});

test('rendered view count is only a fallback when totals are unavailable', () => {
  assert.equal(resolveCurrentViewRecordCount(undefined, undefined, undefined, 50), 50);
});

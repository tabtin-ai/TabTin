import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveExportViewQuery } from '../src/data/services/export-view-query';

const transientFilters = [
  {
    id: 'filter-1',
    field_id: 'status',
    operator: 'equal',
    value: '待处理',
    enabled: true,
  },
];

test('current-view export prefers dirty draft filters over persisted query', () => {
  const result = resolveExportViewQuery(
    { filters: [], filter_logic: 'and', sorts: [], groups: [] },
    {
      isDirty: true,
      filters: transientFilters,
      filter_logic: 'or',
      sorts: [],
      groups: [],
    },
  );

  assert.deepEqual(result.filters, transientFilters);
  assert.equal(result.filter_logic, 'or');
});

test('current-view export preserves explicit empty draft arrays', () => {
  assert.deepEqual(
    resolveExportViewQuery(
      { filters: transientFilters, filter_logic: 'or' },
      {
        isDirty: true,
        filters: [],
        filter_logic: 'and',
        sorts: [],
        groups: [],
      },
    ),
    { filters: [], filter_logic: 'and', sorts: [], groups: [] },
  );
});

test('legacy view export omits transient query when no override exists', () => {
  assert.deepEqual(resolveExportViewQuery({}), {});
});

import { describe, expect, it } from 'vitest';
import { resolveCanvasTreeMoveContext } from './gridRowUtils';

const row = (
  id: string,
  depth: number,
  parentId: string | null = null,
) => ({
  id,
  row_id: id,
  __treeDepth: depth,
  __treeParentId: parentId,
});

describe('resolveCanvasTreeMoveContext', () => {
  it('drops a root row onto a parent row as its child', () => {
    const originalRows = [row('move', 0), row('parent', 0)];
    const reorderedRows = [row('parent', 0), row('move', 0)];

    expect(
      resolveCanvasTreeMoveContext(
        originalRows,
        reorderedRows,
        ['move'],
        { dropMode: 'inside', targetRowId: 'parent' },
      ),
    ).toMatchObject({
      recordId: 'move',
      newParentId: 'parent',
      depthExceeded: false,
    });
  });

  it('inherits parent when dropped before an existing child row', () => {
    const originalRows = [
      row('parent', 0),
      row('child-1', 1, 'parent'),
      row('child-2', 1, 'parent'),
      row('move', 0),
    ];
    const reorderedRows = [
      row('parent', 0),
      row('child-1', 1, 'parent'),
      row('move', 0),
      row('child-2', 1, 'parent'),
    ];

    expect(
      resolveCanvasTreeMoveContext(
        originalRows,
        reorderedRows,
        ['move'],
        { dropMode: 'before', targetRowId: 'child-2' },
      ),
    ).toMatchObject({
      recordId: 'move',
      newParentId: 'parent',
      depthExceeded: false,
    });
  });

  it('inherits parent when dropped after an existing child row', () => {
    const originalRows = [
      row('parent', 0),
      row('child-1', 1, 'parent'),
      row('child-2', 1, 'parent'),
      row('move', 0),
      row('next-root', 0),
    ];
    const reorderedRows = [
      row('parent', 0),
      row('child-1', 1, 'parent'),
      row('child-2', 1, 'parent'),
      row('move', 0),
      row('next-root', 0),
    ];

    expect(
      resolveCanvasTreeMoveContext(
        originalRows,
        reorderedRows,
        ['move'],
        { dropMode: 'after', targetRowId: 'child-2' },
      ),
    ).toMatchObject({
      recordId: 'move',
      newParentId: 'parent',
      depthExceeded: false,
    });
  });

  it('moves an existing child to root when dropped before a root row', () => {
    const originalRows = [
      row('parent', 0),
      row('child', 1, 'parent'),
      row('next-root', 0),
    ];
    const reorderedRows = [
      row('parent', 0),
      row('next-root', 0),
      row('child', 1, 'parent'),
    ];

    expect(
      resolveCanvasTreeMoveContext(
        originalRows,
        reorderedRows,
        ['child'],
        { dropMode: 'before', targetRowId: 'next-root' },
      ),
    ).toMatchObject({
      recordId: 'child',
      newParentId: null,
      depthExceeded: false,
    });
  });

  it('moves an existing child to root when dropped after a root row', () => {
    const originalRows = [
      row('parent', 0),
      row('child', 1, 'parent'),
      row('next-root', 0),
    ];
    const reorderedRows = [
      row('parent', 0),
      row('next-root', 0),
      row('child', 1, 'parent'),
    ];

    expect(
      resolveCanvasTreeMoveContext(
        originalRows,
        reorderedRows,
        ['child'],
        { dropMode: 'after', targetRowId: 'next-root' },
      ),
    ).toMatchObject({
      recordId: 'child',
      newParentId: null,
      depthExceeded: false,
    });
  });

  it('marks depthExceeded when dropping into a depth-4 parent', () => {
    const originalRows = [
      row('d0', 0),
      row('d1', 1, 'd0'),
      row('d2', 2, 'd1'),
      row('d3', 3, 'd2'),
      row('d4', 4, 'd3'),
      row('move', 0),
    ];
    const reorderedRows = [
      row('d0', 0),
      row('d1', 1, 'd0'),
      row('d2', 2, 'd1'),
      row('d3', 3, 'd2'),
      row('d4', 4, 'd3'),
      row('move', 0),
    ];

    expect(
      resolveCanvasTreeMoveContext(
        originalRows,
        reorderedRows,
        ['move'],
        { dropMode: 'inside', targetRowId: 'd4' },
      ),
    ).toMatchObject({
      recordId: 'move',
      newParentId: 'd4',
      depthExceeded: true,
    });
  });
});

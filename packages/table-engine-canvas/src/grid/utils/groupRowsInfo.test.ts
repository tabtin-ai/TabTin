import { describe, expect, it } from 'vitest';
import { LinearRowType } from '../interface';
import { buildGroupRowsInfo } from './groupRowsInfo';

const appendRowHeight = 32;
const groupHeaderHeight = 40;

describe('buildGroupRowsInfo', () => {
  it('keeps a global append row visible when the table has no records', () => {
    const result = buildGroupRowsInfo({
      groupPoints: [{ type: LinearRowType.Append }],
      hasAppendRow: true,
      appendRowHeight,
      groupHeaderHeight,
    });

    expect(result?.rowCount).toBe(1);
    expect(result?.pureRowCount).toBe(0);
    expect(result?.linearRows).toEqual([
      {
        type: LinearRowType.Append,
        value: null,
        realIndex: -1,
        groupPath: undefined,
        groupValues: undefined,
      },
    ]);
    expect(result?.rowHeightMap).toEqual({ 0: appendRowHeight });
  });

  it('keeps group append context when a group has no records', () => {
    const result = buildGroupRowsInfo({
      groupPoints: [
        {
          id: 'todo',
          type: LinearRowType.Group,
          depth: 0,
          value: 'Todo',
        },
        {
          type: LinearRowType.Append,
          groupPath: 'todo',
          groupValues: { Status: 'Todo' },
        },
      ],
      hasAppendRow: true,
      appendRowHeight,
      groupHeaderHeight,
    });

    expect(result?.rowCount).toBe(2);
    expect(result?.linearRows[1]).toEqual({
      type: LinearRowType.Append,
      value: 'Todo',
      realIndex: -1,
      groupPath: 'todo',
      groupValues: { Status: 'Todo' },
    });
    expect(result?.rowHeightMap).toEqual({
      0: groupHeaderHeight,
      1: appendRowHeight,
    });
  });

  it('does not duplicate append rows after normal row groups', () => {
    const result = buildGroupRowsInfo({
      groupPoints: [
        { type: LinearRowType.Row, count: 2 },
        { type: LinearRowType.Append },
      ],
      hasAppendRow: true,
      appendRowHeight,
      groupHeaderHeight,
    });

    expect(result?.rowCount).toBe(3);
    expect(result?.linearRows.map(row => row.type)).toEqual([
      LinearRowType.Row,
      LinearRowType.Row,
      LinearRowType.Append,
    ]);
    expect(result?.linearRows[2]).toMatchObject({
      type: LinearRowType.Append,
      realIndex: 1,
    });
  });

  it('does not expose append rows for collapsed groups', () => {
    const result = buildGroupRowsInfo({
      groupPoints: [
        {
          id: 'todo',
          type: LinearRowType.Group,
          depth: 0,
          value: 'Todo',
          isCollapsed: true,
        },
        {
          type: LinearRowType.Append,
          groupPath: 'todo',
          groupValues: { Status: 'Todo' },
        },
      ],
      hasAppendRow: true,
      appendRowHeight,
      groupHeaderHeight,
    });

    expect(result?.rowCount).toBe(1);
    expect(result?.linearRows).toEqual([
      {
        id: 'todo',
        type: LinearRowType.Group,
        depth: 0,
        value: 'Todo',
        realIndex: 0,
        isCollapsed: true,
      },
    ]);
    expect(result?.rowHeightMap).toEqual({ 0: groupHeaderHeight });
  });

  it('hides all descendants of a collapsed parent group and resumes at its sibling', () => {
    const result = buildGroupRowsInfo({
      groupPoints: [
        {
          id: 'owner-alice',
          type: LinearRowType.Group,
          depth: 0,
          value: 'Alice',
          isCollapsed: true,
        },
        {
          id: 'owner-alice-todo',
          type: LinearRowType.Group,
          depth: 1,
          value: 'Todo',
        },
        { type: LinearRowType.Row, count: 3 },
        { type: LinearRowType.Append, groupPath: 'owner-alice-todo' },
        {
          id: 'owner-alice-done',
          type: LinearRowType.Group,
          depth: 1,
          value: 'Done',
        },
        { type: LinearRowType.Row, count: 1 },
        { type: LinearRowType.Append, groupPath: 'owner-alice-done' },
        {
          id: 'owner-bob',
          type: LinearRowType.Group,
          depth: 0,
          value: 'Bob',
        },
        { type: LinearRowType.Row, count: 1 },
        { type: LinearRowType.Append, groupPath: 'owner-bob' },
      ],
      hasAppendRow: true,
      appendRowHeight,
      groupHeaderHeight,
    });

    expect(result?.linearRows.map(row => row.type)).toEqual([
      LinearRowType.Group,
      LinearRowType.Group,
      LinearRowType.Row,
      LinearRowType.Append,
    ]);
    expect(result?.linearRows[1]).toMatchObject({
      id: 'owner-bob',
      realIndex: 4,
    });
    expect(result?.linearRows[2]).toMatchObject({
      type: LinearRowType.Row,
      realIndex: 4,
    });
    expect(result?.pureRowCount).toBe(5);
    expect(result?.rowCount).toBe(4);
  });
});

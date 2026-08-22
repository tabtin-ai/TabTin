import { describe, expect, it } from 'vitest';
import type { ViewMeta } from '@tabtin/table-core';
import type { PersonalViewDraftLike } from './viewResolution';
import { resolveEffectiveCurrentView } from './viewResolution';

const baseView = (): ViewMeta =>
  ({
    id: 'view-1',
    name: 'Grouped view',
    view_type: 'grid',
    filters: [{ field_id: 'status', operator: 'is', value: 'Open' }],
    groups: [{ field_id: 'status', direction: 'asc' }],
    sorts: [{ field_id: 'created_at', direction: 'desc' }],
    config: { filter_logic: 'or', row_height: 32 },
  }) as unknown as ViewMeta;

const baseKanbanView = (): ViewMeta =>
  ({
    id: 'view-kanban-1',
    name: 'Kanban view',
    view_type: 'kanban',
    filters: [],
    groups: [{ field_id: 'status', direction: 'asc' }],
    sorts: [],
    config: { group_by_field: 'status', card_title_field: 'title' },
  }) as unknown as ViewMeta;

describe('resolveEffectiveCurrentView', () => {
  it('keeps unsaved shared filter/group draft out of the effective view', () => {
    const currentView = baseView();

    const result = resolveEffectiveCurrentView({
      currentView,
      isPersonalViewEnabled: false,
    });

    expect(result).toBe(currentView);
    expect(result?.filters).toEqual([{ field_id: 'status', operator: 'is', value: 'Open' }]);
    expect(result?.groups).toEqual([{ field_id: 'status', direction: 'asc' }]);
    expect(result?.sorts).toEqual([{ field_id: 'created_at', direction: 'desc' }]);
    expect(result?.config).toEqual({ filter_logic: 'or', row_height: 32 });
  });

  it('lets personal view draft override the shared view when personal view is enabled', () => {
    const personalDraft: PersonalViewDraftLike = {
      filters: [{ field_id: 'owner', operator: 'is', value: 'me' }],
      groups: [{ field_id: 'owner', direction: 'asc' }],
      filter_logic: 'or',
    };

    const result = resolveEffectiveCurrentView({
      currentView: baseView(),
      isPersonalViewEnabled: true,
      personalViewDraft: personalDraft,
    });

    expect(result?.filters).toEqual([
      { field_id: 'owner', operator: 'is', value: 'me' },
    ]);
    expect(result?.groups).toEqual([{ field_id: 'owner', direction: 'asc' }]);
    expect(result?.config).toEqual({ filter_logic: 'or', row_height: 32 });
  });

  it('keeps local filter/group draft after popover closes even when personal view is off', () => {
    const result = resolveEffectiveCurrentView({
      currentView: baseView(),
      isPersonalViewEnabled: false,
      personalViewDraft: {
        filters: [{ field_id: 'rating', operator: 'equals', value: 3 }],
        groups: [{ field_id: 'owner', direction: 'asc' }],
        filter_logic: 'and',
      },
    });

    expect(result?.filters).toEqual([
      { field_id: 'rating', operator: 'equals', value: 3 },
    ]);
    expect(result?.groups).toEqual([{ field_id: 'owner', direction: 'asc' }]);
    expect(result?.config).toEqual({ filter_logic: 'and', row_height: 32 });
    // sorts 未出现在本地草稿时保持共享视图
    expect(result?.sorts).toEqual([{ field_id: 'created_at', direction: 'desc' }]);
  });

  it('keeps local sort draft after popover closes even when personal view is off', () => {
    const result = resolveEffectiveCurrentView({
      currentView: baseView(),
      isPersonalViewEnabled: false,
      personalViewDraft: {
        sorts: [{ field_id: 'title', direction: 'asc' }],
      },
    });

    expect(result?.sorts).toEqual([{ field_id: 'title', direction: 'asc' }]);
    expect(result?.groups).toEqual([{ field_id: 'status', direction: 'asc' }]);
  });

  it('applies empty local filter draft to clear shared filters without personal view', () => {
    const result = resolveEffectiveCurrentView({
      currentView: baseView(),
      isPersonalViewEnabled: false,
      personalViewDraft: {
        filters: [],
        groups: [],
        filter_logic: 'and',
      },
    });

    expect(result?.filters).toEqual([]);
    expect(result?.groups).toEqual([]);
  });

  it('applies empty local sort draft to clear shared sorts without personal view', () => {
    const result = resolveEffectiveCurrentView({
      currentView: baseView(),
      isPersonalViewEnabled: false,
      personalViewDraft: {
        sorts: [],
      },
    });

    expect(result?.sorts).toEqual([]);
  });

  it('projects a kanban session draft group onto effective config.group_by_field', () => {
    const result = resolveEffectiveCurrentView({
      currentView: baseKanbanView(),
      isPersonalViewEnabled: false,
      personalViewDraft: {
        groups: [{ field_id: 'assignee', direction: 'asc' }],
      },
    });

    expect(result?.groups).toEqual([{ field_id: 'assignee', direction: 'asc' }]);
    expect((result?.config as Record<string, unknown>)?.group_by_field).toBe('assignee');
    // 其它 config key（如 card_title_field）不受影响
    expect((result?.config as Record<string, unknown>)?.card_title_field).toBe('title');
  });

  it('clears kanban config.group_by_field when the session draft clears groups', () => {
    const result = resolveEffectiveCurrentView({
      currentView: baseKanbanView(),
      isPersonalViewEnabled: false,
      personalViewDraft: {
        groups: [],
      },
    });

    expect(result?.groups).toEqual([]);
    expect((result?.config as Record<string, unknown>)?.group_by_field).toBeUndefined();
  });

  it('projects a kanban personal-view draft group onto effective config.group_by_field', () => {
    const result = resolveEffectiveCurrentView({
      currentView: baseKanbanView(),
      isPersonalViewEnabled: true,
      personalViewDraft: {
        groups: [{ field_id: 'priority', direction: 'asc' }],
      },
    });

    expect(result?.groups).toEqual([{ field_id: 'priority', direction: 'asc' }]);
    expect((result?.config as Record<string, unknown>)?.group_by_field).toBe('priority');
  });
});

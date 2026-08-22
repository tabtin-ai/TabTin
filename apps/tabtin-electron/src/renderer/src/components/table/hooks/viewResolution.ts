import type { ViewMeta } from '@tabtin/table-core';
import { syncKanbanGroupConfig } from '@tabtin/table-core';

export type PersonalViewDraftLike = {
  filters?: ViewMeta['filters'];
  groups?: ViewMeta['groups'];
  sorts?: ViewMeta['sorts'];
  visible_fields?: ViewMeta['visible_fields'];
  field_order?: ViewMeta['field_order'];
  column_meta?: ViewMeta['column_meta'];
  filter_logic?: 'and' | 'or';
  config?: ViewMeta['config'];
};

const mergePersonalViewDraft = (
  view: ViewMeta,
  personalViewDraft: PersonalViewDraftLike,
): ViewMeta => {
  let nextConfig = personalViewDraft.config
    ? {
        ...((view.config as Record<string, unknown>) ?? {}),
        ...personalViewDraft.config,
      }
    : (view.config as Record<string, unknown> | undefined);

  if (
    personalViewDraft.filter_logic === 'and' ||
    personalViewDraft.filter_logic === 'or'
  ) {
    nextConfig = {
      ...(nextConfig ?? {}),
      filter_logic: personalViewDraft.filter_logic,
    };
  }

  // 看板：个人视图分组草稿只有第一级生效，需同步进 config.group_by_field——
  // kanban 渲染只读该字段，不读 view.groups（复用 table-core 同一份映射规则）。
  if (view.view_type === 'kanban' && personalViewDraft.groups !== undefined) {
    nextConfig = syncKanbanGroupConfig(nextConfig, personalViewDraft.groups);
  }

  return {
    ...view,
    ...(personalViewDraft.filters !== undefined
      ? { filters: personalViewDraft.filters }
      : {}),
    ...(personalViewDraft.groups !== undefined
      ? { groups: personalViewDraft.groups }
      : {}),
    ...(personalViewDraft.sorts !== undefined
      ? { sorts: personalViewDraft.sorts }
      : {}),
    ...(personalViewDraft.visible_fields
      ? { visible_fields: personalViewDraft.visible_fields }
      : {}),
    ...(personalViewDraft.field_order
      ? { field_order: personalViewDraft.field_order }
      : {}),
    ...(personalViewDraft.column_meta
      ? { column_meta: personalViewDraft.column_meta }
      : {}),
    config: nextConfig as ViewMeta['config'],
  };
};

/**
 * Session-scoped local drafts (sort / filter / group) must keep applying after
 * the popover closes, even when personal view mode is off. Other personal-draft
 * fields (visible_fields / column_meta / …) stay gated by personal view.
 */
const applyLocalSessionDraft = (
  view: ViewMeta,
  personalViewDraft?: PersonalViewDraftLike,
): ViewMeta => {
  if (!personalViewDraft) {
    return view;
  }

  let next = view;

  if (personalViewDraft.sorts !== undefined) {
    next = {
      ...next,
      sorts: personalViewDraft.sorts,
    };
  }

  if (personalViewDraft.filters !== undefined) {
    next = {
      ...next,
      filters: personalViewDraft.filters,
    };
  }

  if (personalViewDraft.groups !== undefined) {
    next = {
      ...next,
      groups: personalViewDraft.groups,
    };

    // 看板会话草稿：选组即本地换列，保存前也要让 kanban 读到同一份
    // effective config.group_by_field（复用 table-core 的 kanban 映射规则）。
    if (next.view_type === 'kanban') {
      next = {
        ...next,
        config: syncKanbanGroupConfig(
          next.config as Record<string, unknown> | undefined,
          personalViewDraft.groups,
        ),
      };
    }
  }

  if (
    personalViewDraft.filter_logic === 'and' ||
    personalViewDraft.filter_logic === 'or'
  ) {
    next = {
      ...next,
      config: {
        ...((next.config as Record<string, unknown>) ?? {}),
        filter_logic: personalViewDraft.filter_logic,
      },
    };
  }

  return next;
};

export const resolveEffectiveCurrentView = ({
  currentView,
  isPersonalViewEnabled,
  personalViewDraft,
}: {
  currentView: ViewMeta | null;
  isPersonalViewEnabled: boolean;
  personalViewDraft?: PersonalViewDraftLike;
}): ViewMeta | null => {
  if (!currentView) {
    return currentView;
  }

  if (isPersonalViewEnabled && personalViewDraft) {
    return mergePersonalViewDraft(currentView, personalViewDraft);
  }

  return applyLocalSessionDraft(currentView, personalViewDraft);
};

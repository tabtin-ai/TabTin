import React from 'react';
import type { ViewMeta } from '@tabtin/table-core';
import { useTableViewUiStore } from '@stores/useTableViewUiStore';
import type { PersonalViewDraftState } from '@stores/useTableViewUiStore';
import { resolveEffectiveCurrentView } from './viewResolution';

interface UsePersonalViewResolutionInput {
  selectedTableId: string | undefined;
  currentViewId: string | null | undefined;
  currentView: ViewMeta | null;
}

export function usePersonalViewResolution({
  selectedTableId,
  currentViewId,
  currentView,
}: UsePersonalViewResolutionInput) {
  const personalViewByScope = useTableViewUiStore(
    (state) => state.personalViewByScope,
  );
  const personalViewDraftByScope = useTableViewUiStore(
    (state) => state.personalViewDraftByScope,
  );
  const setPersonalViewDraft = useTableViewUiStore(
    (state) => state.setPersonalViewDraft,
  );

  const personalScopeKey =
    selectedTableId && currentViewId
      ? `${selectedTableId}:${currentViewId}`
      : null;

  const isPersonalViewEnabled = personalScopeKey
    ? Boolean(personalViewByScope[personalScopeKey])
    : false;

  const personalViewDraft: PersonalViewDraftState | undefined = personalScopeKey
    ? personalViewDraftByScope[personalScopeKey]
    : undefined;

  const resolvedCurrentView = React.useMemo<ViewMeta | null>(() => {
    return resolveEffectiveCurrentView({
      currentView,
      isPersonalViewEnabled,
      personalViewDraft,
    });
  }, [currentView, isPersonalViewEnabled, personalViewDraft]);

  return {
    resolvedCurrentView,
    isPersonalViewEnabled,
    setPersonalViewDraft,
  };
}

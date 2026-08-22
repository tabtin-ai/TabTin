# @tabtin/table-ui

Reusable UI layer for table features.

This package is the migration target for host-agnostic table UI.

Current migrated modules:
- table controllers: `useDataGridDataset`, `useDataGridColumns`, `useDataGridEditingController`, `cellValueUtils`
- toolbar controllers: `useGridToolbarController`, `useGridToolbarUiState`, `useViewToolbarController`
- view controllers: `useViewContainerState`, `useKanbanViewController`, `useCalendarViewController`, `useGalleryViewController`, `useViewFilterGroupController`
- shared helper: `getViewVisibilitySnapshot`

Current test coverage:
- `useCalendarViewController` field value resolution
- `useDataGridDataset` grouped rows construction
- `useDataGridEditingController` draft-create flow
- `useGridToolbarController` command orchestration
- `useGridToolbarUiState` dialog/edit state orchestration
- `useViewFilterGroupController` save/save-as flow orchestration

Host integration notes:
- `useDataGridEditingController` no longer hard-depends on UI toast implementation. Host should inject `notify` to keep user feedback behavior.

Electron currently consumes these implementations through local bridge exports, so existing import paths remain stable while core logic is reused from this package.

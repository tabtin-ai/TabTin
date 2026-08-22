# @tabtin/table-core

Host-agnostic runtime contracts and shared core utilities for the table domain.

## Scope
- Runtime ports (`api`, `realtime`, `upload`, `i18n`, `telemetry`)
- Runtime registry for host-side injection
- Shared table data services (`TableApiService`, `ViewApiService`, `RecordApiService`, `FieldApiService`, `AttachmentApiService`, `ImportExportApiService`, …)
- Shared import template generation for Excel (`.xlsx`), CSV, and JSON
- Shared table domain types and API endpoint configuration (`configureTableDataClient`)
- Shared domain store factories (`createTableStoreState`, `createViewStoreState`, `createRecordStoreState`)

## Non-goals
- Host-specific implementation details (Electron/Web)
- UI component implementation

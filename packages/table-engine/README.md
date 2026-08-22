# @tabtin/table-engine

Unified grid engine contracts for TabTin table rendering.

## Scope
- Shared renderer props and data structures
- Grid engine metadata and capability contracts
- Engine preference and fallback resolver utilities
- Selection/clipboard/shortcut/freeze contracts for multi-engine alignment
- Shortcut matching helpers and default bindings

## Non-goals
- Concrete rendering implementation
- Host-specific integration details

## Key Contracts
- `selection`: row/cell/range selection state, config, and change context
- `clipboard`: copy/cut/paste payload shape and config
- `shortcuts`: binding config, platform/phase matching, trigger payload
- `freeze`: frozen columns/rows state and config

## Utilities
- `readTableGridEnginePreferenceFromBrowser`: resolve preferred engine from query/localStorage
- `resolveTableGridEngine`: pick active engine with fallback
- `matchesTableGridShortcut` / `resolveTableGridShortcut`: shortcut matching with platform + phase
- `DEFAULT_TABLE_GRID_SHORTCUT_BINDINGS`: baseline cross-platform grid shortcuts

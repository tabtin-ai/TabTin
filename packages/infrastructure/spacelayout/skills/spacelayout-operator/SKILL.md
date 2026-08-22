---
name: spacelayout-operator
description: >
  Manage context-space tabs, groups, and pane layouts.
metadata:
  version: 0.1.0
  tabtin:
    category: developer
    displayName: "Space Layout Operator"
    tags:
      - layout
      - workspace
      - tabs
---

# Space Layout Operator

Use this skill when the task requires managing the user's workspace layout — opening, closing, or rearranging context tabs and split-pane groups.

## Tool Overview

| Tool | Purpose |
|------|---------|
| `list_context_space` | List all tabs, groups, and layout state for a project |
| `set_active_context_tab` | Activate a specific tab (bring it to focus) |
| `close_context_tab` | Close a tab and get the next active tab |
| `restore_context_group` | Ungroup a split-pane group back into individual tabs |
| `assign_pane_content` | Place a tab's content into a specific pane |
| `split_pane_with_tab` | Split an existing pane and insert a tab beside it |
| `move_pane` | Move a pane to a new position within a group |
| `dock_pane` | Dock a pane to a group edge (left/right/top/bottom) |

## Key Concepts

- **Tab** — a single content unit in the context space (table, browser, terminal, etc.), identified by a `tabKey`.
- **Group** — a container that holds one or more **panes** in a split layout, identified by a `groupId`.
- **Pane** — a slot within a group that displays one tab's content, identified by a `paneId`.
- **Layout** — the tree structure describing how panes are split (horizontal/vertical) within a group.

## Workflow Patterns

### Pattern 1 — Inspect Current Layout

1. `list_context_space` with the `spaceId`.
2. Read the response: `tabs[]` for all open tabs, `groups[]` for split-pane arrangements, `activeTabKey` for the focused tab.

### Pattern 2 — Focus a Tab

1. `set_active_context_tab` with `spaceId` and `tabKey`.
2. Optionally pass `paneId` to focus a specific pane within a group.

### Pattern 3 — Build a Side-by-Side Layout

To display two tabs side by side:

1. `list_context_space` to get current tabs and their tabKeys.
2. `split_pane_with_tab` — pick an existing `paneId`, choose `side: "right"` (or `"left"`, `"top"`, `"bottom"`), and provide the `tabKey` to place in the new pane.

### Pattern 4 — Rearrange Panes

- `move_pane` — reorder panes within a group by specifying `sourcePaneId`, `targetPaneId`, and `side`.
- `dock_pane` — push a pane to the edge of a group (e.g., dock to `"bottom"` for a console-like layout).

### Pattern 5 — Clean Up

- `close_context_tab` to close tabs that are no longer needed.
- `restore_context_group` to flatten a group back into separate tabs.

## Rules

- Always call `list_context_space` first to get valid `tabKey`, `groupId`, and `paneId` values — never guess these identifiers.
- When splitting panes, the `tabKey` must refer to a tab that is not already assigned to another pane in the same group.
- After closing a tab, check the `nextActiveTabKey` in the response to know which tab is now focused.
- Layout operations are Space-scoped — always provide the correct `spaceId`.
- Prefer `split_pane_with_tab` for building layouts from scratch; use `move_pane` and `dock_pane` for rearranging existing layouts.

## Safety

- Closing a tab may discard unsaved state in that tab's content (e.g., an unsaved terminal session).
- `restore_context_group` is non-destructive — it preserves all tab content, only flattening the visual layout.
- Do not close tabs programmatically without confirming with the user if the tab may contain unsaved work.

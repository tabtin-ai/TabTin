# @tabtin/doc-editor

Host-agnostic document editor core for TabTin Tabdoc.

## Scope
- host runtime adapters (`upload`, `notify`, `telemetry`, `auth token`)
- markdown plaintext normalization utility
- autosave controller orchestration
- default document extension specs (heading/list/blockquote/code/table/task/link/image)
- tiptap default extension assembly (`createDefaultDocExtensions`)
- content converters (`markdownToPmJson`, `pmJsonToMarkdown`, `pmJsonToHtml`)

## Design Constraints
- No Electron-specific dependency.
- No import from `apps/tabtin-electron/**`.
- Host differences must be implemented via runtime adapter injection.

## Example
```ts
import {
  configureDocEditorHost,
  createAutoSaveController,
} from '@tabtin/doc-editor'

configureDocEditorHost({
  notify: ({ level, message }) => console[level === 'error' ? 'error' : 'log'](message),
})

const controller = createAutoSaveController({
  getDraft: () => ({
    pmJson: {},
    markdown: '# hello',
  }),
  getBaseVersion: () => 3,
  save: async (payload) => ({
    version: 4,
  }),
})

controller.markDirty()
```

## Tiptap Extensions
```ts
import { createDefaultDocExtensions } from '@tabtin/doc-editor'

const extensions = createDefaultDocExtensions({
  profile: {
    table: true,
    taskList: true,
  },
})
```

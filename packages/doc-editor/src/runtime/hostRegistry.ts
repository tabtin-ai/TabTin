import type { DocEditorHostAdapters } from '../types.js'

let hostAdapters: Partial<DocEditorHostAdapters> = {}

export const configureDocEditorHost = (next: Partial<DocEditorHostAdapters>): void => {
  hostAdapters = {
    ...hostAdapters,
    ...next,
  }
}

export const getDocEditorHost = (): Readonly<Partial<DocEditorHostAdapters>> => hostAdapters

export const resetDocEditorHost = (): void => {
  hostAdapters = {}
}

export const requireDocEditorHost = (): Readonly<Partial<DocEditorHostAdapters>> => hostAdapters


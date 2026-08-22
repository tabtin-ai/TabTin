import { NodeSelection, type Selection } from '@tiptap/pm/state'

export function isImageNodeSelection(selection: Selection): selection is NodeSelection {
  return selection instanceof NodeSelection && selection.node.type.name === 'image'
}

export function isImageNodeEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && Boolean(target.closest('.node-image, .tabdoc-image-node-view'))
}

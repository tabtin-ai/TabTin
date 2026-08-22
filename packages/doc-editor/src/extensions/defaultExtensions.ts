export type DocExtensionId =
  | 'heading'
  | 'paragraph'
  | 'bullet_list'
  | 'ordered_list'
  | 'blockquote'
  | 'code_block'
  | 'table'
  | 'task_list'
  | 'link'
  | 'image'

export interface DocExtensionSpec {
  id: DocExtensionId
  label: string
  description: string
  enabledByDefault: boolean
}

export const DOC_DEFAULT_EXTENSION_SPECS: ReadonlyArray<DocExtensionSpec> = [
  {
    id: 'heading',
    label: 'Heading',
    description: 'title hierarchy support',
    enabledByDefault: true,
  },
  {
    id: 'paragraph',
    label: 'Paragraph',
    description: 'plain text paragraph block',
    enabledByDefault: true,
  },
  {
    id: 'bullet_list',
    label: 'Bullet List',
    description: 'unordered list block',
    enabledByDefault: true,
  },
  {
    id: 'ordered_list',
    label: 'Ordered List',
    description: 'ordered list block',
    enabledByDefault: true,
  },
  {
    id: 'blockquote',
    label: 'Blockquote',
    description: 'quoted content block',
    enabledByDefault: true,
  },
  {
    id: 'code_block',
    label: 'Code Block',
    description: 'multi-line code snippet block',
    enabledByDefault: true,
  },
  {
    id: 'table',
    label: 'Table',
    description: 'table block',
    enabledByDefault: true,
  },
  {
    id: 'task_list',
    label: 'Task List',
    description: 'checklist block',
    enabledByDefault: true,
  },
  {
    id: 'link',
    label: 'Link',
    description: 'inline link mark',
    enabledByDefault: true,
  },
  {
    id: 'image',
    label: 'Image',
    description: 'image block',
    enabledByDefault: true,
  },
]

export interface ResolveDocExtensionsInput {
  enabled?: DocExtensionId[]
  disabled?: DocExtensionId[]
}

export const resolveDocExtensions = (input: ResolveDocExtensionsInput = {}): DocExtensionSpec[] => {
  const enabledSet = input.enabled ? new Set(input.enabled) : null
  const disabledSet = input.disabled ? new Set(input.disabled) : null

  return DOC_DEFAULT_EXTENSION_SPECS.filter(spec => {
    if (disabledSet?.has(spec.id)) return false
    if (!enabledSet) return spec.enabledByDefault
    return enabledSet.has(spec.id)
  })
}


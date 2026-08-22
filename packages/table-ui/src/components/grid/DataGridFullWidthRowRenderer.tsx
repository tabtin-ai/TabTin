import type React from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'

interface DataGridFullWidthRowRendererProps {
  data?: {
    __rowType?: string
    __groupLevel?: number
    __groupLabel?: string
    __groupCount?: number
    __groupCollapsed?: boolean
    __groupIsLeaf?: boolean
    __groupPath?: string
    __groupValues?: Record<string, unknown>
  }
  onAddRow?: (context?: { group_path?: string; group_values?: Record<string, unknown> }) => void
  onCommitDraft?: () => void
  onCancelDraft?: () => void
  onToggleGroup?: (groupId: string) => void
  addRowLabel?: string
  groupAddRowLabel?: string
  addRowDraftLabel?: string
  saveDraftLabel?: string
  cancelDraftLabel?: string
  submittingDraftLabel?: string
  hasDraft?: boolean
  draftGroupPath?: string
  isDraftSubmitting?: boolean
  ungroupedLabel?: string
  isReadonly?: boolean
}

const AddRowFullWidthRenderer: React.FC<{
  onAddRow?: (context?: { group_path?: string; group_values?: Record<string, unknown> }) => void
  onCommitDraft?: () => void
  onCancelDraft?: () => void
  addRowLabel: string
  addRowDraftLabel: string
  saveDraftLabel: string
  cancelDraftLabel: string
  submittingDraftLabel: string
  hasDraft: boolean
  isDraftSubmitting: boolean
  addContext?: { group_path?: string; group_values?: Record<string, unknown> }
  indentLevel?: number
  showDraftActions?: boolean
}> = ({
  onAddRow,
  onCommitDraft,
  onCancelDraft,
  addRowLabel,
  addRowDraftLabel,
  saveDraftLabel,
  cancelDraftLabel,
  submittingDraftLabel,
  hasDraft,
  isDraftSubmitting,
  addContext,
  indentLevel = 0,
  showDraftActions = true,
}) => {
  const handleClick = () => {
    onAddRow?.(addContext)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onAddRow?.(addContext)
    }
  }

  const handleCancelDraftMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const handleCancelDraftClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    onCancelDraft?.()
  }

  const handleCommitDraftClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    onCommitDraft?.()
  }

  const inlineStyle =
    indentLevel > 0
      ? {
          paddingLeft: 12 + indentLevel * 16,
        }
      : undefined

  if (hasDraft) {
    if (!showDraftActions) {
      return (
        <div className="tt-add-row tt-add-row--draft" style={inlineStyle}>
          <button
            type="button"
            className="tt-add-row__main"
            onClick={handleClick}
            disabled={isDraftSubmitting}
          >
            <span className="tt-add-row__icon" aria-hidden>
              <Plus size={14} />
            </span>
            <span className="tt-add-row__label">
              {isDraftSubmitting ? submittingDraftLabel : addRowDraftLabel}
            </span>
          </button>
        </div>
      )
    }

    return (
      <div className="tt-add-row tt-add-row--draft" style={inlineStyle}>
        <button
          type="button"
          className="tt-add-row__main"
          onClick={handleClick}
          disabled={isDraftSubmitting}
        >
          <span className="tt-add-row__icon" aria-hidden>
            <Plus size={14} />
          </span>
          <span className="tt-add-row__label">
            {isDraftSubmitting ? submittingDraftLabel : addRowDraftLabel}
          </span>
        </button>
        <div className="tt-add-row__actions">
          <button
            type="button"
            className="tt-add-row__action tt-add-row__action--secondary"
            onMouseDown={handleCancelDraftMouseDown}
            onClick={handleCancelDraftClick}
            disabled={isDraftSubmitting}
          >
            {cancelDraftLabel}
          </button>
          <button
            type="button"
            className="tt-add-row__action tt-add-row__action--primary"
            onClick={handleCommitDraftClick}
            disabled={isDraftSubmitting}
          >
            {isDraftSubmitting ? submittingDraftLabel : saveDraftLabel}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className="tt-add-row"
      style={inlineStyle}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <span className="tt-add-row__icon" aria-hidden>
        <Plus size={14} />
      </span>
      <span className="tt-add-row__label">{addRowLabel}</span>
    </div>
  )
}

const GroupHeaderFullWidthRenderer: React.FC<{
  data?: DataGridFullWidthRowRendererProps['data']
  onToggle?: (groupId: string) => void
  onAddRow?: (context?: { group_path?: string; group_values?: Record<string, unknown> }) => void
  addRowLabel: string
  ungroupedLabel: string
}> = ({ data, onToggle, onAddRow, addRowLabel, ungroupedLabel }) => {
  if (!data) {
    return null
  }

  const level = data.__groupLevel ?? 0
  const label = data.__groupLabel ?? ungroupedLabel
  const collapsed = Boolean(data.__groupCollapsed)
  const canAddOnHeader = collapsed
  const groupId = data.__groupPath as string

  return (
    <div
      className="flex h-9 items-center gap-2 border-b border-border/40 bg-muted/30 pr-2 text-body font-medium text-muted-foreground"
      style={{ paddingLeft: 12 + level * 16 }}
    >
      <button
        type="button"
        className="flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent/40 hover:text-foreground"
        onClick={() => groupId && onToggle?.(groupId)}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </button>
      <span className="truncate">{label}</span>
      {canAddOnHeader ? (
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 rounded-sm px-2 py-1 text-body font-medium text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          onClick={event => {
            event.stopPropagation()
            onAddRow?.({
              group_path: data.__groupPath,
              group_values: data.__groupValues,
            })
          }}
        >
          <Plus size={12} />
          <span>{addRowLabel}</span>
        </button>
      ) : null}
    </div>
  )
}

export const DataGridFullWidthRowRenderer: React.FC<DataGridFullWidthRowRendererProps> = props => {
  const rowType = props?.data?.__rowType

  if (rowType === 'group_header') {
    if (props.isReadonly) {
      return (
        <GroupHeaderFullWidthRenderer
          data={props.data}
          onToggle={props.onToggleGroup}
          addRowLabel=""
          ungroupedLabel={props.ungroupedLabel ?? 'Ungrouped'}
        />
      )
    }
    return (
      <GroupHeaderFullWidthRenderer
        data={props.data}
        onToggle={props.onToggleGroup}
        onAddRow={props.onAddRow}
        addRowLabel={props.groupAddRowLabel ?? props.addRowLabel ?? 'Add row in this group'}
        ungroupedLabel={props.ungroupedLabel ?? 'Ungrouped'}
      />
    )
  }

  if (rowType === 'add') {
    if (props.isReadonly) return null
    return (
      <AddRowFullWidthRenderer
        onAddRow={props.onAddRow}
        onCommitDraft={props.onCommitDraft}
        onCancelDraft={props.onCancelDraft}
        addRowLabel={props.addRowLabel ?? 'Add row'}
        addRowDraftLabel={props.addRowDraftLabel ?? 'Continue draft'}
        saveDraftLabel={props.saveDraftLabel ?? 'Save'}
        cancelDraftLabel={props.cancelDraftLabel ?? 'Cancel'}
        submittingDraftLabel={props.submittingDraftLabel ?? 'Saving...'}
        hasDraft={Boolean(props.hasDraft)}
        isDraftSubmitting={Boolean(props.isDraftSubmitting)}
      />
    )
  }

  if (rowType === 'group_add') {
    if (props.isReadonly) return null
    const groupPath = props.data?.__groupPath
    const isDraftInCurrentGroup = Boolean(
      props.hasDraft && (!props.draftGroupPath || props.draftGroupPath === groupPath)
    )

    return (
      <AddRowFullWidthRenderer
        onAddRow={props.onAddRow}
        addContext={{
          group_path: groupPath,
          group_values: props.data?.__groupValues,
        }}
        onCommitDraft={props.onCommitDraft}
        onCancelDraft={props.onCancelDraft}
        addRowLabel={props.groupAddRowLabel ?? props.addRowLabel ?? 'Add row in this group'}
        addRowDraftLabel={props.addRowDraftLabel ?? 'Continue draft'}
        saveDraftLabel={props.saveDraftLabel ?? 'Save'}
        cancelDraftLabel={props.cancelDraftLabel ?? 'Cancel'}
        submittingDraftLabel={props.submittingDraftLabel ?? 'Saving...'}
        hasDraft={isDraftInCurrentGroup}
        isDraftSubmitting={Boolean(props.isDraftSubmitting)}
        indentLevel={(props.data?.__groupLevel ?? 0) + 1}
      />
    )
  }

  return null
}

export const isDataGridFullWidthRow = (params: any): boolean => {
  const rowNode = params?.rowNode ?? params?.node
  const data = rowNode?.data ?? params?.data
  return data?.__rowType === 'add' || data?.__rowType === 'group_header' || data?.__rowType === 'group_add'
}

export const postSortRowsKeepSpecialRowsAtBottom = (params: { nodes: any[] }) => {
  const nodes = params?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return
  }

  const normalNodes: any[] = []
  const inlineDraftNodes: any[] = []
  const draftNodes: any[] = []
  const addNodes: any[] = []
  const spacerNodes: any[] = []

  nodes.forEach(node => {
    const rowType = node?.data?.__rowType
    switch (rowType) {
      case 'draft':
        if (node?.data?.__inlineDraft) {
          inlineDraftNodes.push(node)
        } else {
          draftNodes.push(node)
        }
        break
      case 'add':
        addNodes.push(node)
        break
      case 'spacer':
        spacerNodes.push(node)
        break
      default:
        normalNodes.push(node)
        break
    }
  })

  const mergedNodes = [...normalNodes]
  inlineDraftNodes.forEach(draftNode => {
    const groupPath = draftNode?.data?.__groupPath
    if (typeof groupPath === 'string' && groupPath.length > 0) {
      const groupAddIndex = mergedNodes.findIndex(
        node => node?.data?.__rowType === 'group_add' && node?.data?.__groupPath === groupPath
      )
      if (groupAddIndex >= 0) {
        mergedNodes.splice(groupAddIndex, 0, draftNode)
        return
      }

      const groupHeaderIndex = mergedNodes.findIndex(
        node => node?.data?.__rowType === 'group_header' && node?.data?.__groupPath === groupPath
      )
      if (groupHeaderIndex >= 0) {
        mergedNodes.splice(groupHeaderIndex + 1, 0, draftNode)
        return
      }
    }

    const fallbackGroupAddIndex = mergedNodes.findIndex(node => node?.data?.__rowType === 'group_add')
    if (fallbackGroupAddIndex >= 0) {
      mergedNodes.splice(fallbackGroupAddIndex, 0, draftNode)
      return
    }

    mergedNodes.push(draftNode)
  })

  nodes.length = 0
  nodes.push(...mergedNodes, ...draftNodes, ...addNodes, ...spacerNodes)
}

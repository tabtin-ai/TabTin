import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'

interface SubagentDisclosureContextValue {
  expandedRunByOwner: Readonly<Record<string, string | null>>
  toggle: (ownerKey: string, runId: string) => void
  collapse: (ownerKey: string) => void
}

const SubagentDisclosureContext = createContext<SubagentDisclosureContextValue | null>(null)

/** 展开状态属于会话阅读面，而不是会被虚拟器卸载的消息行。 */
export function SubagentDisclosureProvider({ children }: { children: React.ReactNode }) {
  const [expandedRunByOwner, setExpandedRunByOwner] = useState<Record<string, string | null>>({})
  const toggle = useCallback((ownerKey: string, runId: string) => {
    setExpandedRunByOwner((previous) => ({
      ...previous,
      [ownerKey]: previous[ownerKey] === runId ? null : runId,
    }))
  }, [])
  const collapse = useCallback((ownerKey: string) => {
    setExpandedRunByOwner((previous) => (previous[ownerKey] == null ? previous : { ...previous, [ownerKey]: null }))
  }, [])
  const value = useMemo(() => ({ expandedRunByOwner, toggle, collapse }), [expandedRunByOwner, toggle, collapse])
  return <SubagentDisclosureContext.Provider value={value}>{children}</SubagentDisclosureContext.Provider>
}

export function useSubagentDisclosure(ownerKey: string) {
  const context = useContext(SubagentDisclosureContext)
  const [localExpandedRunId, setLocalExpandedRunId] = useState<string | null>(null)
  const expandedRunId = context?.expandedRunByOwner[ownerKey] ?? localExpandedRunId
  const toggle = useCallback(
    (runId: string) => {
      if (context) context.toggle(ownerKey, runId)
      else setLocalExpandedRunId((previous) => (previous === runId ? null : runId))
    },
    [context, ownerKey],
  )
  const collapse = useCallback(() => {
    if (context) context.collapse(ownerKey)
    else setLocalExpandedRunId(null)
  }, [context, ownerKey])
  return { expandedRunId, toggle, collapse }
}

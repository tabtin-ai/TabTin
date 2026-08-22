import { useEffect } from 'react'
import { ORG_CONTEXT_RESET_EVENT } from '@/services/dismissOrgScopedTransientUi'

/** 手搓浮层：切组织广播到来时关闭本地 open 态。 */
export function useCloseOnOrganizationContextReset(close: () => void): void {
  useEffect(() => {
    const onReset = () => {
      close()
    }
    window.addEventListener(ORG_CONTEXT_RESET_EVENT, onReset)
    return () => window.removeEventListener(ORG_CONTEXT_RESET_EVENT, onReset)
  }, [close])
}

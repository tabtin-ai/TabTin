import { forwardRef, useImperativeHandle, useState } from 'react'
import { ByokConnectDialog } from './ByokConnectDialog'
import { OPENAI_COMPATIBLE_SERVICE_ID } from './byok-service-catalog'

export interface ByokConnectEntriesHandle {
  open: () => void
  openService: (serviceId: string) => void
  openPlan: (presetId?: string) => void
  openApi: (providerName?: string) => void
}

interface ByokConnectEntriesProps {
  organizationId: string
  canManageOrganization: boolean
  isPersonalOrganization?: boolean
  disabled?: boolean
  existingProviderKeys?: string[]
  onSuccess: (message: string) => void | Promise<void>
}

export const ByokConnectEntries = forwardRef<ByokConnectEntriesHandle, ByokConnectEntriesProps>(
  function ByokConnectEntries(props, ref) {
    const {
      organizationId,
      canManageOrganization,
      isPersonalOrganization = false,
      disabled = false,
      existingProviderKeys = [],
      onSuccess,
    } = props
    const [dialogOpen, setDialogOpen] = useState(false)
    const [initialServiceId, setInitialServiceId] = useState<string | undefined>()

    const openWith = (serviceId?: string) => {
      setInitialServiceId(serviceId)
      setDialogOpen(true)
    }

    useImperativeHandle(ref, () => ({
      open: () => openWith(undefined),
      openService: (serviceId: string) => openWith(serviceId),
      openPlan: (presetId?: string) => openWith(presetId ?? 'volcengine_coding_plan'),
      openApi: (providerName?: string) => {
        if (!providerName || providerName === 'openai') {
          openWith(OPENAI_COMPATIBLE_SERVICE_ID)
          return
        }
        openWith(providerName)
      },
    }))

    return (
      <ByokConnectDialog
        open={dialogOpen}
        onOpenChange={(nextOpen) => {
          setDialogOpen(nextOpen)
          if (!nextOpen) setInitialServiceId(undefined)
        }}
        organizationId={organizationId}
        canManageOrganization={canManageOrganization}
        isPersonalOrganization={isPersonalOrganization}
        initialServiceId={initialServiceId}
        disabled={disabled}
        existingProviderKeys={existingProviderKeys}
        onSuccess={onSuccess}
      />
    )
  },
)

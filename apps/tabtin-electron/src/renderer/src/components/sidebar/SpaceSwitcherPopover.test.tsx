import React, { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { selectSpace, activateForegroundSpace } = vi.hoisted(() => ({
  selectSpace: vi.fn(),
  activateForegroundSpace: vi.fn(),
}))

const workspaces = [
  {
    id: 'workspace-current',
    source_id: 'workspace-current',
    organization_id: 'org-1',
    navigationKind: 'workspace',
    type: 'workspace',
    name: '当前工作空间',
    unread_count: 0,
    control_device_id: 'device-local',
  },
  {
    id: 'workspace-next',
    source_id: 'workspace-next',
    organization_id: 'org-1',
    navigationKind: 'workspace',
    type: 'workspace',
    name: '其他工作空间',
    unread_count: 0,
    control_device_id: 'device-remote',
  },
]

const devices = [
  {
    id: 'device-local',
    organization_id: 'org-1',
    fingerprint: 'local-installation',
    name: 'Local Mac',
    status: 'online',
  },
  {
    id: 'device-remote',
    organization_id: 'org-1',
    fingerprint: 'remote-installation',
    name: 'Remote Mac',
    status: 'online',
  },
  {
    id: 'device-daemon',
    organization_id: 'org-1',
    fingerprint: 'daemon-installation',
    name: 'Home Server',
    status: 'offline',
  },
]

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    spaces: workspaces,
    agentCache: {},
  }),
}))

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    getSpaceList: () => workspaces,
    selectSpace,
  }),
}))

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    devices,
    currentDevice: devices[0],
  }),
}))

vi.mock('@/hooks/queries/accountDevices', () => ({
  useAccountDevicesQuery: () => ({
    data: [
      {
        device_id: 'control-remote',
        installation_id: 'remote-installation',
        name: 'Remote Mac',
        roles: [2],
        control_state: 1,
      },
      {
        device_id: 'control-daemon',
        installation_id: 'daemon-installation',
        name: 'Home Server',
        roles: [2],
        control_state: 1,
      },
      {
        device_id: 'control-unmapped',
        installation_id: 'not-in-django',
        name: 'Unmapped Device',
        roles: [2],
        control_state: 1,
      },
    ],
  }),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    selectedOrganization: { id: 'org-1' },
  }),
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    pinnedAgentIds: [],
    togglePinnedAgent: vi.fn(),
    workspaceListSortMode: 'manual',
  }),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    conversations: [],
    unreadCounts: {},
  }),
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    closeSettings: vi.fn(),
  }),
}))

vi.mock('@/stores/useWorkbenchSceneStore', () => ({
  useWorkbenchSceneStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    activateForegroundSpace,
  }),
}))

vi.mock('@/stores/chat/session/reconcileSpacePointer', () => ({
  alignChatPointerToWorkspace: vi.fn(),
}))

vi.mock('./NewSpaceButton', () => ({
  NewSpaceButton: () => null,
}))

import { SpaceSwitcherPopover } from './SpaceSwitcherPopover'

function TooltipParent() {
  const [pickerOpen, setPickerOpen] = useState(false)
  return (
    <>
      <span data-testid="tooltip-state">{pickerOpen ? 'suppressed' : 'visible'}</span>
      <SpaceSwitcherPopover
        currentSpaceId="workspace-current"
        onOpenChange={setPickerOpen}
        onSelectSpace={vi.fn()}
      >
        <button type="button">切换工作空间</button>
      </SpaceSwitcherPopover>
    </>
  )
}

describe('SpaceSwitcherPopover', () => {
  it('shows the execution device for each workspace while daemon-control UI is gated off', async () => {
    render(<TooltipParent />)

    fireEvent.click(screen.getByRole('button', { name: '切换工作空间' }))

    expect(await screen.findByText('Local Mac · 本机')).toBeTruthy()
    expect(screen.getByText('Remote Mac · 在线')).toBeTruthy()
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByText('Home Server')).toBeNull()
    expect(screen.queryByText('Unmapped Device')).toBeNull()
  })

  it('selecting another workspace closes the picker and restores parent hover state', async () => {
    render(<TooltipParent />)

    fireEvent.click(screen.getByRole('button', { name: '切换工作空间' }))
    await screen.findByText('其他工作空间')
    expect(screen.getByTestId('tooltip-state').textContent).toBe('suppressed')

    fireEvent.click(screen.getByText('其他工作空间'))

    await waitFor(() => {
      expect(screen.getByTestId('tooltip-state').textContent).toBe('visible')
    })
  })
})

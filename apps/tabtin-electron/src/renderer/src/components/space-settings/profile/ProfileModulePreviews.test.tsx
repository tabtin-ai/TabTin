import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Agent } from '@tabtin/app-shell'
import { WorkingDirPreview } from './ProfileModulePreviews'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; device?: string }) => {
      let value = options?.defaultValue ?? _key
      if (options?.device) {
        value = value.replace('{{device}}', options.device)
      }
      return value
    },
  }),
}))

const deviceStoreState = vi.hoisted(() => ({
  devices: [] as Array<{
    id: string
    name: string
    status: string
    last_heartbeat_at?: string | null
    os_info?: Record<string, unknown>
  }>,
  currentDeviceId: null as string | null,
}))

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: (selector?: (s: {
    devices: typeof deviceStoreState.devices
    currentDevice: { id: string } | null
  }) => unknown) => {
    const state = {
      devices: deviceStoreState.devices,
      currentDevice: deviceStoreState.currentDeviceId
        ? { id: deviceStoreState.currentDeviceId }
        : null,
    }
    return selector ? selector(state) : state.devices
  },
}))

vi.mock('@stores/useMemoRecordStyleStore', () => ({
  useMemoRecordStyleStore: () => vi.fn(),
}))

vi.mock('@stores/useSpaceApps', () => ({
  EMPTY_APPS: [],
  EMPTY_DISABLED_APPS: [],
  useSpaceApps: () => [],
}))

vi.mock('@stores/useExtensionStore', () => ({
  useExtensionStore: () => [],
}))

vi.mock('@/stores/useChannelStore', () => ({
  useChannelStore: () => [],
}))

vi.mock('@/hooks/queries/skills', () => ({
  useSkillsListQuery: () => ({ data: [], isLoading: false }),
}))

vi.mock('@/skills/types', () => ({
  normalizeSkillSource: (source: string) => source,
}))

vi.mock('@/services/subagentTemplateApi', () => ({
  SubAgentTemplateApi: {},
}))

vi.mock('@/services/recordStyleApi', () => ({
  RecordStyleApi: {},
}))

const remoteViewerState = vi.hoisted(() => ({
  isRemoteViewer: false,
  isResolving: false,
  controlDeviceName: null as string | null,
}))

vi.mock('@components/context-space/hooks/useIsRemoteViewer', () => ({
  useIsRemoteViewer: () => ({
    isRemoteViewer: remoteViewerState.isRemoteViewer,
    isResolving: remoteViewerState.isResolving,
    controlDeviceName: remoteViewerState.controlDeviceName,
    controlDeviceId: remoteViewerState.isRemoteViewer ? 'remote-device' : 'local-device',
    workingDir: null,
  }),
}))

describe('WorkingDirPreview', () => {
  beforeEach(() => {
    remoteViewerState.isRemoteViewer = false
    remoteViewerState.isResolving = false
    remoteViewerState.controlDeviceName = null
    deviceStoreState.devices = []
    deviceStoreState.currentDeviceId = null
    window.tabtin = {
      fileSystem: {
        pathExists: vi.fn().mockResolvedValue({ exists: false, isDirectory: false }),
      },
    } as unknown as typeof window.tabtin
  })
  it('uses the Space working_dir while the Agent cache is still loading', () => {
    render(
      <WorkingDirPreview
        agent={null}
        space={{
          working_dir: 'C:\\Users\\me\\Downloads\\VoiceSync-Windows-0.3.1',
          working_dir_type: 'mixed',
        }}
      />,
    )

    expect(screen.getByText('C:\\Users\\me\\Downloads\\VoiceSync-Windows-0.3.1')).toBeTruthy()
    expect(screen.getByText('混合 · 未绑定设备')).toBeTruthy()
    expect(screen.queryByText(/尚未设置运行目录/)).toBeNull()
  })

  it('uses Space.working_dir as SSOT even when Agent working_dir is empty ', () => {
    render(
      <WorkingDirPreview
        agent={{ working_dir: '', working_dir_type: '' } as Agent}
        space={{
          working_dir: 'C:\\Users\\me\\Downloads\\VoiceSync-Windows-0.3.1',
          working_dir_type: 'mixed',
        }}
      />,
    )

    expect(screen.getByText('C:\\Users\\me\\Downloads\\VoiceSync-Windows-0.3.1')).toBeTruthy()
    expect(screen.getByText('混合 · 未绑定设备')).toBeTruthy()
    expect(screen.queryByText(/尚未设置运行目录/)).toBeNull()
  })

  it('does not show invalid warning when viewing remotely even if local path is missing', async () => {
    remoteViewerState.isRemoteViewer = true
    remoteViewerState.controlDeviceName = 'sedas-MacBook-Air.local (darwin)'

    render(
      <WorkingDirPreview
        agent={null}
        space={{
          id: 'space-remote',
          working_dir: '/Users/seda/TabTin/demo',
          working_dir_type: 'mixed',
        }}
      />,
    )

    expect(screen.getByText('/Users/seda/TabTin/demo')).toBeTruthy()
    expect(screen.getByText('混合 · 在「sedas-MacBook-Air.local (darwin)」上运行')).toBeTruthy()
    expect(screen.queryByText('目录无法访问')).toBeNull()
  })

  it('merges local device summary into working-dir meta line', () => {
    deviceStoreState.currentDeviceId = 'dev-local'
    deviceStoreState.devices = [{
      id: 'dev-local',
      name: 'My Laptop',
      status: 'online',
      os_info: { platform: 'win32', version: '10' },
    }]
    window.tabtin = {
      fileSystem: {
        pathExists: vi.fn().mockResolvedValue({ exists: true, isDirectory: true }),
      },
    } as unknown as typeof window.tabtin

    render(
      <WorkingDirPreview
        agent={null}
        space={{
          working_dir: 'C:\\Users\\me\\project',
          working_dir_type: 'mixed',
          control_device_id: 'dev-local',
        }}
      />,
    )

    expect(screen.getByText('C:\\Users\\me\\project')).toBeTruthy()
    expect(screen.getByText('混合 · 本机（在线）')).toBeTruthy()
  })

  it('shows combined empty hint when neither device nor working dir is set', () => {
    render(
      <WorkingDirPreview
        agent={null}
        space={{ working_dir: null, working_dir_type: null }}
      />,
    )

    expect(
      screen.getByText('尚未设置工作目录。绑定设备并选择目录后，Tin 才能在你的电脑上跑命令、读文件。'),
    ).toBeTruthy()
  })
})

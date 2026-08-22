import { describe, expect, it } from 'vitest'

import { getVisibleWorkspaceSettingsSectionKeys } from './SpaceSettingsPane'

describe('Space settings sections', () => {
  it('does not expose retired Space-level sharing or delegation entry', () => {
    expect(getVisibleWorkspaceSettingsSectionKeys()).not.toContain('sharing')
  })

  it('does not expose retired Space-level developer API entry', () => {
    expect(getVisibleWorkspaceSettingsSectionKeys()).not.toContain('api')
  })

  it('does not expose hidden Agent integrations entry', () => {
    expect(getVisibleWorkspaceSettingsSectionKeys()).not.toContain('extensions')
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_CHAT_PANES, useChatSplitStore } from '../useChatSplitStore'

function resetStore() {
  useChatSplitStore.setState({
    splitBySpace: {},
    pinnedSessionsBySpace: {},
  })
}

describe('useChatSplitStore.purgeStaleEntries', () => {
  beforeEach(resetStore)

  it('保留 desktop/conversation workspace scopes', () => {
    useChatSplitStore.setState({
      splitBySpace: {
        'desktop:organization:wt-1:user:user-1': {
          layout: { type: 'leaf', paneId: 'pane-desktop' },
          panes: [{ id: 'pane-desktop', sessionId: 'session-desktop' }],
          activePaneId: 'pane-desktop',
        },
        'conversation:session-1': {
          layout: { type: 'leaf', paneId: 'pane-conversation' },
          panes: [{ id: 'pane-conversation', sessionId: 'session-conversation' }],
          activePaneId: 'pane-conversation',
        },
        'deleted-space': {
          layout: { type: 'leaf', paneId: 'pane-deleted' },
          panes: [{ id: 'pane-deleted', sessionId: 'session-deleted' }],
          activePaneId: 'pane-deleted',
        },
      },
      pinnedSessionsBySpace: {
        'desktop:organization:wt-1:user:user-1': ['session-desktop'],
        'conversation:session-1': ['session-conversation'],
        'deleted-space': ['session-deleted'],
      },
    })

    useChatSplitStore.getState().purgeStaleEntries(new Set(['space-1']))

    const state = useChatSplitStore.getState()
    expect(state.splitBySpace['desktop:organization:wt-1:user:user-1']).toBeDefined()
    expect(state.splitBySpace['conversation:session-1']).toBeDefined()
    expect(state.splitBySpace['deleted-space']).toBeUndefined()
    expect(state.pinnedSessionsBySpace['desktop:organization:wt-1:user:user-1']).toEqual(['session-desktop'])
    expect(state.pinnedSessionsBySpace['conversation:session-1']).toEqual(['session-conversation'])
    expect(state.pinnedSessionsBySpace['deleted-space']).toBeUndefined()
  })

  it('保留 cloud-docs 域派生 scope', () => {
    useChatSplitStore.setState({
      splitBySpace: {
        'cloud-docs:organization:org-1:user:user-1': {
          layout: { type: 'leaf', paneId: 'pane-cloud' },
          panes: [{ id: 'pane-cloud', sessionId: 'session-cloud' }],
          activePaneId: 'pane-cloud',
        },
        'deleted-space': {
          layout: { type: 'leaf', paneId: 'pane-deleted' },
          panes: [{ id: 'pane-deleted', sessionId: 'session-deleted' }],
          activePaneId: 'pane-deleted',
        },
      },
      pinnedSessionsBySpace: {
        'cloud-docs:organization:org-1:user:user-1': ['session-cloud'],
        'deleted-space': ['session-deleted'],
      },
    })

    useChatSplitStore.getState().purgeStaleEntries(new Set(['space-1']))

    const state = useChatSplitStore.getState()
    expect(state.splitBySpace['cloud-docs:organization:org-1:user:user-1']).toBeDefined()
    expect(state.splitBySpace['deleted-space']).toBeUndefined()
    expect(state.pinnedSessionsBySpace['cloud-docs:organization:org-1:user:user-1']).toEqual(['session-cloud'])
    expect(state.pinnedSessionsBySpace['deleted-space']).toBeUndefined()
  })
})

describe('useChatSplitStore.setSplitSizes', () => {
  beforeEach(resetStore)

  it('does not rewrite split state when sizes are unchanged', () => {
    useChatSplitStore.setState({
      splitBySpace: {
        'space-1': {
          layout: {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            sizes: [0.5, 0.5],
            children: [
              { type: 'leaf', paneId: 'pane-1' },
              { type: 'leaf', paneId: 'pane-2' },
            ],
          },
          panes: [
            { id: 'pane-1', sessionId: 'session-1' },
            { id: 'pane-2', sessionId: 'session-2' },
          ],
          activePaneId: 'pane-2',
        },
      },
      pinnedSessionsBySpace: {},
    })

    const before = useChatSplitStore.getState()
    useChatSplitStore.getState().setSplitSizes('space-1', [], [0.5, 0.5])

    expect(useChatSplitStore.getState()).toBe(before)
  })
})

describe('useChatSplitStore.splitPane', () => {
  beforeEach(resetStore)

  it('allows up to five chat panes and ignores additional split attempts', () => {
    const store = useChatSplitStore.getState()
    store.initSinglePane('space-1', 'session-1')

    for (let index = 2; index <= MAX_CHAT_PANES; index += 1) {
      useChatSplitStore.getState().splitPane('space-1', `session-${index}`)
    }

    expect(useChatSplitStore.getState().splitBySpace['space-1']?.panes).toHaveLength(5)

    const before = useChatSplitStore.getState().splitBySpace['space-1']
    useChatSplitStore.getState().splitPane('space-1', 'session-6')

    const after = useChatSplitStore.getState().splitBySpace['space-1']
    expect(after).toBe(before)
    expect(after?.panes.map(pane => pane.sessionId)).not.toContain('session-6')
  })
})

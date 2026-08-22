/** @store-category prefs */

export { useTableViewUiStore } from '@tabtin/table-ui'
export type { PersonalViewDraftState } from '@tabtin/table-ui'

import { useTableViewUiStore } from '@tabtin/table-ui'
import { registerResetAction } from './sessionResetRegistry'

registerResetAction('table-view-ui', 'reset', () => useTableViewUiStore.getState().reset())

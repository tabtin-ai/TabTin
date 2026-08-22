import { create } from 'zustand'

export type NewUserOrganizationOnboardingStep =
  | 'intro'
  | 'me_entry'
  | 'team_entry'
  | 'organization_choice'
  | 'create_organization'
  | 'members_entry'
  | 'invite_hint'
  | 'invite_dialog'
  | 'agent_chat'

interface StoredOnboardingState {
  step?: NewUserOrganizationOnboardingStep
  skippedOrganization?: boolean
  completed?: boolean
  updatedAt?: number
}

interface NewUserOrganizationOnboardingState {
  activeUserId: string | null
  step: NewUserOrganizationOnboardingStep | null
  skippedOrganization: boolean
  completed: boolean
  startForUser: (userId: string | number | null | undefined) => void
  resumeForUser: (userId: string | number | null | undefined) => void
  resetForUser: (userId: string | number | null | undefined) => void
  goToStep: (step: NewUserOrganizationOnboardingStep) => void
  skipOrganizationModule: () => void
  complete: () => void
  clearRuntime: () => void
}

const storageKeyForUser = (userId: string) => `tabtin:onboarding:new-user-organization:${userId}`

function normalizeUserId(userId: string | number | null | undefined): string | null {
  if (userId == null) return null
  const normalized = String(userId).trim()
  return normalized || null
}

function readStoredState(userId: string): StoredOnboardingState | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(storageKeyForUser(userId))
    if (!raw) return null
    return JSON.parse(raw) as StoredOnboardingState
  } catch {
    return null
  }
}

function writeStoredState(userId: string, patch: StoredOnboardingState): StoredOnboardingState {
  const next = {
    ...(readStoredState(userId) ?? {}),
    ...patch,
    updatedAt: Date.now(),
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(storageKeyForUser(userId), JSON.stringify(next))
  }
  return next
}

function removeStoredState(userId: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(storageKeyForUser(userId))
}

export const useNewUserOrganizationOnboardingStore = create<NewUserOrganizationOnboardingState>()(
  (set, get) => ({
    activeUserId: null,
    step: null,
    skippedOrganization: false,
    completed: false,

    startForUser: (rawUserId) => {
      const userId = normalizeUserId(rawUserId)
      if (!userId) return

      const stored = readStoredState(userId)
      if (stored?.completed) {
        set({
          activeUserId: userId,
          step: null,
          skippedOrganization: Boolean(stored.skippedOrganization),
          completed: true,
        })
        return
      }

      const next = writeStoredState(userId, {
        step: stored?.step ?? 'intro',
        skippedOrganization: Boolean(stored?.skippedOrganization),
        completed: false,
      })
      set({
        activeUserId: userId,
        step: next.step ?? 'intro',
        skippedOrganization: Boolean(next.skippedOrganization),
        completed: false,
      })
    },

    resumeForUser: (rawUserId) => {
      const userId = normalizeUserId(rawUserId)
      if (!userId) {
        get().clearRuntime()
        return
      }
      if (get().activeUserId === userId) return

      const stored = readStoredState(userId)
      if (!stored || stored.completed || !stored.step) {
        set({
          activeUserId: userId,
          step: null,
          skippedOrganization: Boolean(stored?.skippedOrganization),
          completed: Boolean(stored?.completed),
        })
        return
      }

      set({
        activeUserId: userId,
        step: stored.step,
        skippedOrganization: Boolean(stored.skippedOrganization),
        completed: false,
      })
    },

    resetForUser: (rawUserId) => {
      const userId = normalizeUserId(rawUserId)
      if (!userId) return
      removeStoredState(userId)
      set({
        activeUserId: userId,
        step: null,
        skippedOrganization: false,
        completed: false,
      })
      get().startForUser(userId)
    },

    goToStep: (step) => {
      const userId = get().activeUserId
      if (!userId || get().completed) return
      writeStoredState(userId, { step, completed: false })
      set({ step, completed: false })
    },

    skipOrganizationModule: () => {
      const userId = get().activeUserId
      if (!userId || get().completed) return
      writeStoredState(userId, {
        step: 'agent_chat',
        skippedOrganization: true,
        completed: false,
      })
      set({
        step: 'agent_chat',
        skippedOrganization: true,
        completed: false,
      })
    },

    complete: () => {
      const userId = get().activeUserId
      if (!userId) return
      writeStoredState(userId, {
        step: undefined,
        completed: true,
      })
      set({
        step: null,
        completed: true,
      })
    },

    clearRuntime: () => {
      set({
        activeUserId: null,
        step: null,
        skippedOrganization: false,
        completed: false,
      })
    },
  }),
)

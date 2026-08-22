/** @store-category prefs */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createMigratingStorage, withPersistSafety } from '@tabtin/shared'
import { PERSIST_KEYS } from './persist-key-registry'
import i18n from 'i18next'
import apiService from '@/services/api'
import type { UserProfileSettings, UserProfileSettingsUpdateRequest } from '@/types/auth'
import {
  DEFAULT_LANGUAGE_PREFERENCE,
  type LanguagePreference,
  type SupportedLanguage,
  resolveDevLanguagePreference,
  resolvePreference,
  normalizeLanguage,
} from '@/i18n/language'

interface I18nState {
  preference: LanguagePreference
  resolvedLanguage: SupportedLanguage
  setPreference: (preference: LanguagePreference) => void
  applyPreference: (preference: LanguagePreference) => void
  syncFromServer: () => Promise<UserProfileSettings | null>
  saveToServer: (preference: LanguagePreference) => Promise<void>
}

// 语言偏好后台同步重试参数：本地切换是即时且已持久化的，服务端同步只是
// 跨设备最终一致，失败不该打断用户，故仅做有限次轻量退避重试后静默放弃。
const LANGUAGE_SYNC_MAX_ATTEMPTS = 3
const LANGUAGE_SYNC_RETRY_BASE_MS = 500

const resolveLanguage = (preference: LanguagePreference): SupportedLanguage => {
  return resolvePreference(preference)
}

const applyLanguage = (language: SupportedLanguage) => {
  if (i18n.language !== language) {
    void i18n.changeLanguage(language)
  }
  // overlay / 独立窗口是另一套 i18n 实例，切换后必须显式广播。
  try {
    window.tabtin?.overlay?.syncLocale?.(language)
  } catch {
    /* overlay may not be ready */
  }
}

export const useI18nStore = create<I18nState>()(
  persist(
    (set, get) => ({
      preference: DEFAULT_LANGUAGE_PREFERENCE,
      resolvedLanguage: resolveLanguage(DEFAULT_LANGUAGE_PREFERENCE),
      setPreference: (preference) => {
        const resolved = resolveLanguage(preference)
        set({ preference, resolvedLanguage: resolved })
        applyLanguage(resolved)
      },
      applyPreference: (preference) => {
        const resolved = resolveLanguage(preference)
        set({ preference, resolvedLanguage: resolved })
        applyLanguage(resolved)
      },
      syncFromServer: async () => {
        try {
          const settings = await apiService.getProfileSettings()
          const devPin = resolveDevLanguagePreference()
          if (devPin) {
            // 本地开发钉语言：不让服务端 system/en-US 把界面盖回英文
            get().setPreference(devPin)
            return settings
          }
          const serverPreference = settings?.language
          if (serverPreference) {
            const normalized = normalizeLanguage(serverPreference) ?? (serverPreference === 'system' ? 'system' : null)
            if (normalized) {
              get().setPreference(normalized)
            }
          }
          return settings
        } catch (error) {
          console.error('[I18n] Failed to sync language settings:', error)
          return null
        }
      },
      saveToServer: async (preference) => {
        // 后台静默同步：本地切换已即时生效并持久化，这里只把偏好写到服务端用于
        // 跨设备一致。任何失败都不向上抛、不打断 UI——做有限次轻量退避重试后静默
        // 记录日志放弃（下次 syncFromServer / 用户再次切换会重新写入）。
        const payload: UserProfileSettingsUpdateRequest = {
          language: preference,
        }
        for (let attempt = 1; attempt <= LANGUAGE_SYNC_MAX_ATTEMPTS; attempt++) {
          try {
            await apiService.updateProfileSettings(payload)
            return
          } catch (error) {
            if (attempt === LANGUAGE_SYNC_MAX_ATTEMPTS) {
              console.warn(
                '[I18n] 语言偏好后台同步失败（本地已生效，将在下次同步时重试）:',
                error,
              )
              return
            }
            await new Promise((resolve) => setTimeout(resolve, attempt * LANGUAGE_SYNC_RETRY_BASE_MS))
          }
        }
      },
    }),
    withPersistSafety({
      name: PERSIST_KEYS.i18n,
      storage: createJSONStorage(() => createMigratingStorage(localStorage, ['tabtin-i18n-store'])),
      partialize: (state) => ({
        preference: state.preference,
      }),
      version: 1,
      migrate: (persisted: unknown, _version: number) => persisted,
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const devPin = resolveDevLanguagePreference()
        state.applyPreference(devPin ?? state.preference)
      },
    })
  )
)

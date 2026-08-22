/**
 * app-shell 运行时初始化 — Web 适配器
 *
 * 在应用启动时调用 initAppShellForWeb()，注入 Web 特有的实现。
 * 对应 Electron 的 apps/tabtin-electron/src/renderer/src/adapters/app-shell-init.ts
 */

import { configureAppShell, initAppShellStores } from '@tabtin/app-shell';
import { API_BASE_URL } from '@/config/api';
import { STORAGE_KEYS } from '@/platform';
import { useAuthStore } from '@/stores/auth-store';
import { refreshAccessToken } from '@/services/token-refresh';
import { authAdapter } from '@/platform';
import { resetChatClient } from '@/services/chatApi';

let _refreshPromise: Promise<string | null> | null = null;

async function refreshOnce(): Promise<string | null> {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    try {
      const refreshToken = localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
      if (!refreshToken) return null;
      const result = await refreshAccessToken(refreshToken, authAdapter);
      return result?.access_token ?? null;
    } finally {
      _refreshPromise = null;
    }
  })();
  return _refreshPromise;
}

export function initAppShellForWeb(): void {
  configureAppShell({
    apiBaseUrl: API_BASE_URL || `${window.location.origin}/api`,

    transport: async (options) => {
      let response = await fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
      });

      if (response.status === 401) {
        const newToken = await refreshOnce();
        if (newToken) {
          const retryHeaders = {
            ...options.headers,
            Authorization: `Bearer ${newToken}`,
          };
          response = await fetch(options.url, {
            method: options.method,
            headers: retryHeaders,
            body: options.body,
          });
        }
      }

      const data = await response.json().catch(() => null);
      return { status: response.status, data };
    },

    auth: {
      getToken: async () => localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN),
      getCurrentUserId: () => useAuthStore.getState().user?.id ?? null,
    },

    bridge: {
      setActiveSpace: () => {},
      resetChatClient,
    },
  });

  initAppShellStores();
}

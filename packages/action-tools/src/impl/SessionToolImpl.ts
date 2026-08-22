import { ToolErrorCode, ToolErrorFactory, type ToolError } from '../types/errors';

export interface ManageCookiesInput {
  action: 'get' | 'set' | 'clear';
  crawlTabId?: string;
  runId?: string;
  domain?: string;
  url?: string;
  cookies?: Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    expires?: number;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
}

export interface ManageCookiesOutput {
  success: boolean;
  data?: {
    cookies?: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      secure: boolean;
      httpOnly: boolean;
      expires: number;
    }>;
    cleared_count?: number;
    set_count?: number;
  };
  error?: ToolError;
}

export interface ClearSessionInput {
  crawlTabId?: string;
  runId?: string;
  clearCookies?: boolean;
  clearLocalStorage?: boolean;
  clearCache?: boolean;
}

export interface ClearSessionOutput {
  success: boolean;
  data?: { cleared: string[] };
  error?: ToolError;
}

export class SessionToolImpl {
  private electronViewGetter: ((tabId: string) => any) | null = null;
  private defaultSessionGetter: (() => any) | null = null;

  setElectronViewGetter(getter: (tabId: string) => any): void {
    this.electronViewGetter = getter;
  }

  setDefaultSessionGetter(getter: () => any): void {
    this.defaultSessionGetter = getter;
  }

  private resolveSession(tabId?: string): { session: any; error?: ManageCookiesOutput } {
    if (tabId && this.electronViewGetter) {
      const view = this.electronViewGetter(tabId);
      if (!view || view.webContents.isDestroyed()) {
        return {
          session: null,
          error: {
            success: false,
            error: ToolErrorFactory.fatal(ToolErrorCode.TAB_NOT_FOUND, `Tab ${tabId} not found or destroyed`),
          },
        };
      }
      return { session: view.webContents.session };
    }

    if (!tabId && this.defaultSessionGetter) {
      const defaultSession = this.defaultSessionGetter();
      if (defaultSession) {
        return { session: defaultSession };
      }
    }

    if (!tabId) {
      return {
        session: null,
        error: {
          success: false,
          error: ToolErrorFactory.fatal(
            ToolErrorCode.INVALID_PARAMETER,
            'No crawlTabId provided and no default session available. Open a browser tab first, or pass the crawlTabId of an existing tab.',
          ),
        },
      };
    }

    return {
      session: null,
      error: {
        success: false,
        error: ToolErrorFactory.fatal(ToolErrorCode.IPC_NOT_AVAILABLE, 'Electron view getter not available'),
      },
    };
  }

  async manageCookies(input: ManageCookiesInput): Promise<ManageCookiesOutput> {
    const { session, error } = this.resolveSession(input.crawlTabId);
    if (error) return error;

    try {
      switch (input.action) {
        case 'get': {
          const filter: Record<string, string> = {};
          if (input.url) filter.url = input.url;
          if (input.domain) filter.domain = input.domain;
          const raw = await session.cookies.get(filter);
          const cookies = raw.map((c: any) => ({
            name: c.name,
            value: c.value,
            domain: c.domain || '',
            path: c.path || '/',
            secure: c.secure || false,
            httpOnly: c.httpOnly || false,
            expires: c.expirationDate || -1,
          }));
          return { success: true, data: { cookies } };
        }

        case 'set': {
          if (!input.cookies?.length) {
            return {
              success: false,
              error: ToolErrorFactory.fatal(ToolErrorCode.INVALID_PARAMETER, 'cookies array is required for set action'),
            };
          }
          for (const cookie of input.cookies) {
            const domain = cookie.domain || input.domain || '';
            if (!domain) {
              return {
                success: false,
                error: ToolErrorFactory.fatal(
                  ToolErrorCode.INVALID_PARAMETER,
                  `Cookie "${cookie.name}" has no domain. Provide domain in the cookie object or in the top-level domain field.`,
                ),
              };
            }
            const protocol = cookie.secure ? 'https' : 'http';
            const host = domain.startsWith('.') ? domain.substring(1) : domain;
            const cookieUrl = `${protocol}://${host}${cookie.path || '/'}`;

            let sameSite: 'no_restriction' | 'lax' | 'strict' | undefined;
            if (cookie.sameSite) {
              const raw = cookie.sameSite.toLowerCase();
              if (raw === 'none') sameSite = 'no_restriction';
              else if (raw === 'strict') sameSite = 'strict';
              else sameSite = 'lax';
            }

            await session.cookies.set({
              url: cookieUrl,
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
              secure: sameSite === 'no_restriction' ? true : cookie.secure,
              httpOnly: cookie.httpOnly,
              expirationDate: cookie.expires,
              ...(sameSite ? { sameSite } : {}),
            });
          }
          return { success: true, data: { set_count: input.cookies.length } };
        }

        case 'clear': {
          const filter: Record<string, string> = {};
          if (input.url) filter.url = input.url;
          if (input.domain) filter.domain = input.domain;
          const toDelete = await session.cookies.get(filter);
          let cleared = 0;
          for (const cookie of toDelete) {
            const domain = cookie.domain || input.domain || '';
            if (!domain) continue;
            const protocol = cookie.secure ? 'https' : 'http';
            const host = domain.startsWith('.') ? domain.substring(1) : domain;
            const cookieUrl = `${protocol}://${host}${cookie.path || '/'}`;
            await session.cookies.remove(cookieUrl, cookie.name);
            cleared++;
          }
          return { success: true, data: { cleared_count: cleared } };
        }

        default:
          return {
            success: false,
            error: ToolErrorFactory.fatal(
              ToolErrorCode.INVALID_PARAMETER,
              `Unknown action: ${input.action}. Use get, set, or clear`,
            ),
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: ToolErrorFactory.retriable(ToolErrorCode.UNKNOWN_ERROR, message),
      };
    }
  }

  async clearSession(input: ClearSessionInput): Promise<ClearSessionOutput> {
    const { session, error } = this.resolveSession(input.crawlTabId);
    if (error) {
      return { success: false, error: error.error };
    }
    const clearCookies = input.clearCookies !== false;
    const clearLocalStorage = input.clearLocalStorage !== false;
    const clearCache = input.clearCache !== false;

    const cleared: string[] = [];
    try {
      const storages: string[] = [];
      if (clearCookies) storages.push('cookies');
      if (clearLocalStorage) storages.push('localstorage');
      if (clearCache) storages.push('cachestorage');

      if (storages.length > 0) {
        await session.clearStorageData({ storages: storages as any[] });
        cleared.push(...storages);
      }

      if (clearCache) {
        await session.clearCache();
        if (!cleared.includes('cache')) cleared.push('cache');
      }

      return { success: true, data: { cleared } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: ToolErrorFactory.retriable(ToolErrorCode.UNKNOWN_ERROR, message),
      };
    }
  }
}

let sharedImpl: SessionToolImpl | null = null;
export function getSharedSessionToolImpl(): SessionToolImpl {
  if (!sharedImpl) {
    sharedImpl = new SessionToolImpl();
  }
  return sharedImpl;
}

import { createLogger } from '../logger.js'
import { guardedHandle } from '../utils/guarded-handle.js'
import {
  OpenAICodexCredentialStore,
  sharedOpenAICodexCredentialStore,
} from './openai-codex-credential-store.js'
import {
  OpenAICodexLogin,
} from './openai-codex-login.js'
import { notifyOpenAICodexStatusChanged } from './openai-codex-status-events.js'
import { OPENAI_CODEX_MODELS } from './openai-codex-models.js'

const log = createLogger('OpenAICodex')

type RegisterHandle = (
  channel: string,
  listener: (event: unknown, ...args: unknown[]) => unknown,
) => void

type OpenAICodexIpcDependencies = {
  registerHandle?: RegisterHandle
  credentialStore?: Pick<OpenAICodexCredentialStore, 'read' | 'modify' | 'delete'>
  login?: Pick<OpenAICodexLogin, 'startBrowserLogin' | 'startDeviceCodeLogin' | 'cancelLogin'>
}

export const OPENAI_CODEX_IPC_CHANNELS = [
  'openai-codex:get-status',
  'openai-codex:login-browser',
  'openai-codex:login-device-code',
  'openai-codex:logout',
  'openai-codex:cancel-login',
] as const

function okData<T>(data: T) {
  return { ok: true as const, data }
}

function errData(code: string, message: string) {
  return {
    ok: false as const,
    error: { code, message },
  }
}

/**
 * 注册本机 Codex 登录 IPC（envelope：`{ ok, data }` / `{ ok, error }`）。
 *
 * device-code channel 立即返回用户码与验证地址；轮询与凭据保存留在主进程后台完成。
 * renderer 随后轮询 get-status，因此永远无法获得 access/refresh token。
 */
export function registerOpenAICodexIpc(
  dependencies: OpenAICodexIpcDependencies = {},
): void {
  const registerHandle = dependencies.registerHandle ?? guardedHandle
  const credentialStore =
    dependencies.credentialStore ?? sharedOpenAICodexCredentialStore
  const login = dependencies.login ?? new OpenAICodexLogin({ credentialStore })

  registerHandle('openai-codex:get-status', async () => {
    try {
      const credential = await credentialStore.read()
      return okData({
        connected: credential !== null,
        ...(credential ? { expiresAt: credential.expires } : {}),
        models: OPENAI_CODEX_MODELS.map(({ id, displayName }) => ({
          id,
          displayName,
        })),
      })
    } catch (error) {
      log.warn(
        'Failed to read Codex status:',
        error instanceof Error ? error.message : String(error),
      )
      return errData('CODEX_STATUS_FAILED', '无法读取 ChatGPT Codex 登录状态。')
    }
  })

  registerHandle('openai-codex:login-browser', async () => {
    try {
      await login.startBrowserLogin()
      return okData({ started: true as const })
    } catch (error) {
      log.warn(
        'Browser login could not start:',
        error instanceof Error ? error.message : String(error),
      )
      return errData('CODEX_LOGIN_START_FAILED', '无法启动 ChatGPT 浏览器登录，请重试。')
    }
  })

  registerHandle('openai-codex:login-device-code', async () => {
    try {
      const started = await login.startDeviceCodeLogin()
      return okData(started)
    } catch (error) {
      log.warn(
        'Device code login could not start:',
        error instanceof Error ? error.message : String(error),
      )
      return errData('CODEX_DEVICE_CODE_START_FAILED', '无法启动 ChatGPT 设备码登录，请重试。')
    }
  })

  registerHandle('openai-codex:logout', async () => {
    try {
      login.cancelLogin()
      await credentialStore.delete()
      await notifyOpenAICodexStatusChanged('disconnected')
      return okData({ loggedOut: true as const })
    } catch (error) {
      log.warn(
        'Codex logout failed:',
        error instanceof Error ? error.message : String(error),
      )
      return errData('CODEX_LOGOUT_FAILED', '断开 ChatGPT Codex 失败，请重试。')
    }
  })

  registerHandle('openai-codex:cancel-login', () => {
    login.cancelLogin()
    return okData({ cancelled: true as const })
  })
}

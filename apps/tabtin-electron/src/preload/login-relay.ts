import type {
  LoginRelayAPI,
  LoginRelayCancelResult,
  LoginRelayCompleteResult,
  LoginRelayStartResult,
} from '../shared/types/login-relay'

type Invoke = <T>(channel: string, input: unknown) => Promise<T>

export function createLoginRelayPreloadApi(invoke: Invoke): LoginRelayAPI {
  return {
    start: (request) =>
      invoke<LoginRelayStartResult>('login-relay:start', request),
    complete: (request) =>
      invoke<LoginRelayCompleteResult>('login-relay:complete', request),
    cancel: (request) =>
      invoke<LoginRelayCancelResult>('login-relay:cancel', request),
  }
}

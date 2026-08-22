export type {
  LatencyClass,
  PlatformType,
  BackendCapabilities,
  ExecuteParams,
  BackendExecutionResult,
  InteractiveSession,
  ExecutionBackend,
  BackendConfig,
  BackendFactory,
  BackendResolveConfig,
} from './types';

export { ExecutionBackendRegistry } from './registry';

export {
  SpawnSandboxBackend,
  SpawnSandboxBackendFactory,
  SPAWN_SANDBOX_BACKEND_CAPABILITIES,
} from './spawn-sandbox-backend';

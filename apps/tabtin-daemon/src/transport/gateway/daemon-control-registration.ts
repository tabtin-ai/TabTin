import {
  deriveApiBaseUrl,
  joinApiPath,
  requireSecureCredentialApiBaseUrl,
} from '@tabtin/config';
import type { DaemonConfig } from '../../base/types/daemon-config.js';
import type { KernelLogger } from '../../platform/observability/logging/logger.js';
import { readDaemonVersion } from '../../platform/system/update/daemon-version.js';

const REGISTER_PATH = '/daemon-control/v1/devices/register';

interface DeviceResponse {
  success?: boolean;
  data?: {
    device?: {
      device_id?: string;
      capabilities?: { revision?: number };
    };
  };
}

function responseRevision(response: DeviceResponse): number {
  const value = response.data?.device?.capabilities?.revision;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function isDaemonControlRegistrationEnabled(config: DaemonConfig): boolean {
  const enabledOverride = process.env.DAEMON_CONTROL_ENABLED?.trim();
  return enabledOverride === undefined
    ? config.daemon_control_enabled === true
    : enabledOverride === 'true';
}

export async function registerDaemonControlDevice(
  config: DaemonConfig,
  capabilities: string[],
  logger: KernelLogger,
): Promise<boolean> {
  if (!isDaemonControlRegistrationEnabled(config)) return false;
  try {
    const configuredBaseUrl = process.env.TABTIN_DAEMON_CONTROL_API_BASE_URL?.trim()
      || config.daemon_control_api_base_url?.trim();
    const apiBaseUrl = requireSecureCredentialApiBaseUrl(
      deriveApiBaseUrl(configuredBaseUrl || config.server_url),
    );
    const runtimeProfile = {
      os: process.platform,
      arch: process.arch,
      app_version: readDaemonVersion(),
      capabilities,
    };
    const response = await fetch(joinApiPath(apiBaseUrl, REGISTER_PATH), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.credential}`,
      },
      body: JSON.stringify({
        installation_id: config.fingerprint,
        name: config.device_name,
        kind: 2,
        ...runtimeProfile,
      }),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const registration = await response.json() as DeviceResponse;
    const deviceId = registration.data?.device?.device_id?.trim();
    if (registration.success !== true || !deviceId) {
      throw new Error('invalid response');
    }

    const storedRevision = config.daemon_control_runtime_profile_revision;
    const capabilitiesRevision = Math.max(
      typeof storedRevision === 'number' && Number.isSafeInteger(storedRevision) && storedRevision > 0
        ? storedRevision
        : 1,
      responseRevision(registration) || 1,
    ) + 1;
    const syncResponse = await fetch(joinApiPath(
      apiBaseUrl,
      `/daemon-control/v1/devices/${encodeURIComponent(deviceId)}/runtime-profile`,
    ), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.credential}`,
      },
      body: JSON.stringify({
        ...runtimeProfile,
        capabilities_revision: capabilitiesRevision,
      }),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (!syncResponse.ok) {
      throw new Error(`runtime profile HTTP ${syncResponse.status}`);
    }
    const synced = await syncResponse.json() as DeviceResponse;
    if (synced.success !== true) {
      throw new Error('invalid runtime profile response');
    }
    config.daemon_control_runtime_profile_revision = Math.max(
      capabilitiesRevision,
      responseRevision(synced),
    );
    logger.info(`[Daemon Control] Device registered: ${config.fingerprint}`);
    return true;
  } catch (error) {
    logger.warn(
      `[Daemon Control] Device registration failed (non-critical): ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

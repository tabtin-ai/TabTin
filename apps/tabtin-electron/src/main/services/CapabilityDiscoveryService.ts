import { API_BASE_URL } from '../config/api.js';
import { TokenManager } from '../auth.js';
import { createLogger } from '../logger';
import { getDeviceFingerprint } from '../utils/deviceFingerprint';
import { getLocalMcpService } from './LocalMcpService';
import { joinApiPath } from '@tabtin/config';
import {
  CAPABILITY_DISCOVERY_SNAPSHOT_VERSION,
  capabilityIdBuilders,
  createRuntimeToolItems,
  type CapabilityId,
  type HostRuntimeSnapshot,
} from '@tabtin/shared';
import type { LocalMcpConnectionSummary } from '@shared/types/mcp';

const log = createLogger('CapabilityDiscovery');

export const ELECTRON_DEVICE_CAPABILITIES = [
  'terminal_execute',
  'terminal_read',
  'terminal_write',
  'browser',
  'file',
  'gui',
  'mcp',
  'git',
  'code_search',
];

export interface CoreCliNamespaceSummary {
  capability_id: CapabilityId;
  name: string;
  description: string;
  examples: string[];
}

export interface CapabilityDiscoveryBackendSummary {
  space_id: string;
  organization_id: string;
  generated_at: string;
  backend_type: string;
  space_device_binding: {
    bound_device_id?: string | null;
    control_device_id?: string | null;
  };
  execution_binding: {
    bound: boolean;
    binding_source: string;
    device_id?: string | null;
    device_fingerprint?: string | null;
    device_name?: string | null;
    device_type?: string | null;
    device_status?: string | null;
    last_heartbeat_at?: string | null;
    refresh_transport: string;
    can_refresh_via_backend: boolean;
    can_refresh_locally: boolean;
    reason_codes: string[];
  };
  execution_snapshot: {
    available: boolean;
    observed_at?: string | null;
    freshness_state: string;
    stale_reason?: string | null;
    reason_codes: string[];
    snapshot_version?: number | null;
    snapshot_source?: string | null;
    runtime_tools_count: number;
    mcp_tools_count: number;
    snapshot?: HostRuntimeSnapshot | null;
  };
}

export interface CapabilityDiscoverySummary {
  generated_at: string;
  backend: CapabilityDiscoveryBackendSummary | null;
  local_host: {
    fingerprint: string;
    runtime_snapshot: HostRuntimeSnapshot;
    core_cli: CoreCliNamespaceSummary[];
    local_mcp_connections: LocalMcpConnectionSummary[];
  };
}

export interface CapabilityRefreshResponse {
  local: boolean;
  result: Record<string, unknown>;
  summary: CapabilityDiscoverySummary;
}

type CoreCliCatalogEntry = {
  name?: string;
  description?: string;
  examples?: string[];
};

export class CapabilityDiscoveryService {
  constructor(
    private readonly getRegisteredTools: () => string[],
  ) {}

  async getSummary(spaceId: string): Promise<CapabilityDiscoverySummary> {
    const [backend, runtimeSnapshot, coreCli, localMcpConnections] = await Promise.all([
      this.fetchBackendSummary(spaceId).catch((error) => {
        log.warn(`fetch backend summary failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }),
      this.collectCurrentHostRuntimeSnapshot(),
      this.getCoreCliCatalog(),
      Promise.resolve(getLocalMcpService().listConnections()),
    ]);

    return {
      generated_at: new Date().toISOString(),
      backend,
      local_host: {
        fingerprint: getDeviceFingerprint(),
        runtime_snapshot: runtimeSnapshot,
        core_cli: coreCli,
        local_mcp_connections: localMcpConnections,
      },
    };
  }

  async refreshExecution(spaceId: string): Promise<CapabilityRefreshResponse> {
    const currentSummary = await this.getSummary(spaceId);
    const backend = currentSummary.backend;
    if (!backend) {
      return {
        local: false,
        result: {
          status: 'failed',
          reason_code: 'source_partial_error',
        },
        summary: currentSummary,
      };
    }

    const boundFingerprint = backend.execution_binding.device_fingerprint ?? null;
    const currentFingerprint = getDeviceFingerprint();
    if (
      backend.execution_binding.can_refresh_locally
      && boundFingerprint
      && boundFingerprint === currentFingerprint
    ) {
      await this.sendLocalHeartbeatRefresh();
      return {
        local: true,
        result: {
          status: 'accepted',
          reason_code: 'refresh_supported',
        },
        summary: await this.getSummary(spaceId),
      };
    }

    // G-034: API 现在返回 202 + pending，不再阻塞等待设备响应。
    // 前端通过 WS 订阅 device.capabilities.refresh.{organizationId} 接收结果。
    const response = await this.requestBackendRefresh(spaceId);
    return {
      local: false,
      result: response,
      summary: currentSummary,
    };
  }

  async collectCurrentHostRuntimeSnapshot(): Promise<HostRuntimeSnapshot> {
    const runtimeTools = this.getRegisteredTools();
    const reportedAt = new Date().toISOString();

    return {
      version: CAPABILITY_DISCOVERY_SNAPSHOT_VERSION,
      source: 'electron',
      reported_at: reportedAt,
      runtime_tools: createRuntimeToolItems(runtimeTools, reportedAt),
    };
  }

  private async getCoreCliCatalog(): Promise<CoreCliNamespaceSummary[]> {
    const { CORE_COMMAND_CATALOG } = await import('../cli/core-command-catalog');
    const catalog = Array.isArray(CORE_COMMAND_CATALOG)
      ? CORE_COMMAND_CATALOG as CoreCliCatalogEntry[]
      : [];

    return catalog
      .map((command) => ({
        name: typeof command.name === 'string' ? command.name : '',
        description: typeof command.description === 'string' ? command.description : '',
        examples: Array.isArray(command.examples)
          ? command.examples.filter((item): item is string => typeof item === 'string')
          : [],
      }))
      .filter((command) => command.name)
      .map((command) => ({
        ...command,
        capability_id: capabilityIdBuilders.coreCli(command.name),
      }));
  }

  private async fetchBackendSummary(spaceId: string): Promise<CapabilityDiscoveryBackendSummary> {
    const data = await this.requestJson<{ success?: boolean; data?: CapabilityDiscoveryBackendSummary }>(
      `/context/spaces/${spaceId}/capability-discovery`,
      { method: 'GET' },
    );
    if (!data?.data) {
      throw new Error('Capability discovery summary missing');
    }
    return data.data;
  }

  private async requestBackendRefresh(spaceId: string): Promise<Record<string, unknown>> {
    const data = await this.requestJsonAllowFailure<{ success?: boolean; data?: Record<string, unknown> }>(
      `/context/spaces/${spaceId}/capability-refresh`,
      {
        method: 'POST',
        body: JSON.stringify({
          requested_by: 'electron_ipc',
          timeout_seconds: 12,
        }),
      },
    );
    return data?.data ?? {};
  }

  private async sendLocalHeartbeatRefresh(): Promise<void> {
    const token = await TokenManager.getAccessToken();
    if (!token) {
      throw new Error('Access token missing');
    }

    const fingerprint = getDeviceFingerprint();
    const snapshot = await this.collectCurrentHostRuntimeSnapshot();
    const response = await fetch(joinApiPath(API_BASE_URL, '/context/devices/heartbeat'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        fingerprint,
        capabilities: ELECTRON_DEVICE_CAPABILITIES,
        system_info: {
          host_runtime_snapshot: snapshot,
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Local heartbeat refresh failed: HTTP ${response.status}`);
    }
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const token = await TokenManager.getAccessToken();
    if (!token) {
      throw new Error('Access token missing');
    }

    const response = await fetch(joinApiPath(API_BASE_URL, path), {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });

    let data: T | null = null;
    try {
      data = await response.json() as T;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const message = (data as { message?: string } | null)?.message
        ?? `HTTP ${response.status}`;
      throw new Error(message);
    }

    return data as T;
  }

  private async requestJsonAllowFailure<T>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const token = await TokenManager.getAccessToken();
    if (!token) {
      throw new Error('Access token missing');
    }

    const response = await fetch(joinApiPath(API_BASE_URL, path), {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });

    try {
      return await response.json() as T;
    } catch {
      return {} as T;
    }
  }
}

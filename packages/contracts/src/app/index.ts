// ─── HTTP Transport ──────────────────────────────────────────────────

export type AppHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface AppHttpRequest {
  url: string;
  method: AppHttpMethod;
  headers?: Record<string, string>;
  body?: string;
}

export interface AppHttpResponse<T = unknown> {
  data: T;
  status: number;
  headers?: Record<string, string>;
  statusText?: string;
}

export type AppHttpTransport = <T = unknown>(
  req: AppHttpRequest,
) => Promise<AppHttpResponse<T>>;

// ─── Request Options ─────────────────────────────────────────────────

export interface AppRequestOptions {
  method: AppHttpMethod;
  endpoint: string;
  params?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  expectedStatus?: number | number[];
  rawResponse?: boolean;
}

// ─── API Envelope ────────────────────────────────────────────────────

export interface AppApiEnvelope<T> {
  success?: boolean;
  data?: T;
  message?: string;
  code?: number | string;
  detail?: string;
}

// ─── Host Context ────────────────────────────────────────────────────

export interface AppHostContext {
  appId: string;
  spaceId: string | null;
  organizationId: string | null;
  getAccessToken: () => Promise<string | null> | string | null;
  baseApiUrl: string;
  showToast?: (message: string, level?: 'info' | 'error' | 'success' | 'warning') => void;
  navigate?: (target: { type: string; id: string }) => void;
  httpTransport?: AppHttpTransport;
}

export interface AppHostContextUpdate {
  spaceId?: string | null;
  organizationId?: string | null;
  baseApiUrl?: string;
}

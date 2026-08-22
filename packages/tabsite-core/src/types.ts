/**
 * Shared type definitions for TabSite core — consumed by both Electron and Daemon.
 */

export type DjangoRequestFn = (
  method: string,
  path: string,
  body?: any,
  opts?: { logTag?: string; timeout?: number },
) => Promise<{ status: number; data: any }>;

export interface ProvisionResult {
  tokenProvisioned: boolean;
  tokenAlreadyExists?: boolean;
  tokenExpiresSoon?: boolean;
  error?: string;
}

export interface ProvisionOptions {
  force?: boolean;
}

export interface CopyDirOptions {
  extraSkip?: string[];
}

export interface DistFile {
  relativePath: string;
  absolutePath: string;
  size: number;
}

export interface UploadDistOptions {
  siteId: string;
  distPath: string;
  djangoRequest: DjangoRequestFn;
  allowedRoots: string[];
  organizationId?: string | null;
  onProgress?: (done: number, total: number) => void;
}

export interface UploadDistResult {
  success: boolean;
  dist_url?: string;
  file_count?: number;
  total_size?: number;
  skipped_files?: string[];
  failed_files?: Array<{ path: string; error: string }>;
  error?: string;
  error_code?: string;
  detail?: any;
}

export interface InitTemplateOptions {
  siteId: string;
  /** workspace 归属（沿用 spaceId 字段名，兼容期语义 = workspaceId） */
  spaceId: string;
  /** Organization 归属；#7268 硬切必填（禁止 `_unscoped`） */
  organizationId: string;
  /**
   *  硬切：新布局 per-user 存储树必填字段，不再接受 undefined
   * 静默落到 `_unscoped`——调用方必须解析出真实登录用户后再调用本函数。
   */
  userId: string;
  djangoRequest: DjangoRequestFn;
  /**
   * 新单根（/#7268）。站点项目存在
   * `{dataRoot}/users/{userId}/organizations/{orgId}/workspaces/{spaceId}/sites/{siteSlug}/`
   * 下，与用户本地工作目录物理隔离。
   */
  dataRoot: string;
  templateSearchPaths: string[];
}

export interface InitTemplateResult {
  success: boolean;
  code_project_path?: string;
  already_exists?: boolean;
  template?: string;
  token_provisioned?: boolean;
  token_warning?: string;
  token_expires_soon?: boolean;
  error?: string;
}

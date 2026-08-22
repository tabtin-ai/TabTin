/**
 * Manifest（工作区物料化声明）类型占位 —— 对应 M1 §3.4 / 总控 Part 3.6.1。
 *
 * **M1 范围**：仅类型占位，让 Capability.process_manifest 接口能被 tsc
 * 接受。**不实现任何物料化逻辑** —— 物料化（把 entries 变成真实文件）
 * 由 M3 LocalVMBackend / M4 CloudBackend 自己实现。
 *
 * **Native 不消费**：M2 NativeBackendSession 的 `manifest` 字段为
 * `undefined` —— 因为 Native 直接在用户宿主磁盘运行，不需要"物料化"。
 *
 * **字段冻结**：本文件类型字段对齐总控 Part 3.6.1，下游模块 import 后
 * 一律按此实现。可加字段，不能删 / 改语义。
 */

/**
 * 文件 / 目录条目的权限元数据。物料化时 Backend 应映射到 OS 级 chmod。
 * M3 / M4 实施时按需扩展（例：扩展属性、ACL 等）。
 */
export interface Permissions {
  /** Unix 风格 `0o755` 等 */
  mode?: number;
  /** 用户名（依赖 manifest.users 列表） */
  owner?: string;
  /** 组名（依赖 manifest.groups 列表） */
  group?: string;
  /** 是否对 Agent 可写。Backend 物料化后可附加额外只读 mount 处理 */
  writable?: boolean;
}

interface BaseEntry {
  type: string;
  description?: string;
  /** 临时条目不进 snapshot / persist 流程（典型：tmpfs） */
  ephemeral?: boolean;
  permissions?: Permissions;
}

/** 内联文件：content 直接写在 manifest 里。适合小文本 / 配置 */
export interface FileEntry extends BaseEntry {
  type: 'file';
  /** 文本或二进制内容；Buffer 在 process_manifest 链路中保留引用即可 */
  content: string | Buffer;
}

/** 引用宿主磁盘上的本地文件（相对 base_dir） */
export interface LocalFileEntry extends BaseEntry {
  type: 'local_file';
  src: string;
}

/** 内联目录：children 是嵌套 entries */
export interface DirEntry extends BaseEntry {
  type: 'dir';
  children: Record<string, Entry>;
}

/** 引用宿主磁盘上的本地目录（递归 mirror） */
export interface LocalDirEntry extends BaseEntry {
  type: 'local_dir';
  src: string;
}

/** Git repo 克隆条目（M3 / M4 物料化时 clone） */
export interface GitRepoEntry extends BaseEntry {
  type: 'git_repo';
  /** 默认 'github.com'；自定义 host 用于内网 GitLab 等 */
  host: string;
  /** owner/repo 形式 */
  repo: string;
  /** branch / tag / commit sha */
  ref: string;
  /** 仅挂载 repo 子路径 */
  subpath?: string;
}

/** 远端存储挂载（S3 / OSS / NAS） */
export interface MountEntry extends BaseEntry {
  type: 'mount';
  provider: 's3' | 'oss' | 'nas' | string;
  config: Record<string, unknown>;
  readOnly: boolean;
}

export type Entry =
  | FileEntry
  | LocalFileEntry
  | DirEntry
  | LocalDirEntry
  | GitRepoEntry
  | MountEntry;

/** 用户定义（manifest.users 数组项），物料化时映射到 OS 用户 */
export interface User {
  name: string;
  uid?: number;
  shell?: string;
  /** 主组名（需在 manifest.groups 中存在） */
  primaryGroup?: string;
  /** 附加组 */
  groups?: string[];
}

/** 组定义 */
export interface Group {
  name: string;
  gid?: number;
}

/**
 * 工作区外的额外路径授权（白名单方式 grant Agent 访问）。
 * 物料化时 Backend 应在 sandbox / Backend 配置中 expose 这些路径。
 */
export interface PathGrant {
  path: string;
  readOnly: boolean;
  description?: string;
}

/**
 * 工作区物料化声明。
 *
 * Native：未使用（NativeBackendSession.manifest === undefined）
 * LocalVM：M3 据此在 VM 内生成 `/workspace` 内容 + bind mount
 * Cloud：M4 调 ACS API 据此初始化 sandbox + NAS 挂载
 */
export interface Manifest {
  /** 硬版本号；未来破坏性修改必升 */
  version: 1;
  /** 工作区根路径，默认 '/workspace' */
  root: string;
  /** key = 相对 root 的路径（如 'src/index.ts'） */
  entries: Record<string, Entry>;
  /** 子进程环境变量补充（关卡 1 env-sanitize 之后再叠加） */
  environment?: Record<string, string>;
  users?: User[];
  groups?: Group[];
  extraPathGrants?: PathGrant[];
  /** 远端 mount 命令的 allowlist（M3/M4 用于授权特定 mount/unmount 命令） */
  remoteMountCommandAllowlist?: string[];
}

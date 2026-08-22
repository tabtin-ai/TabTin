/**
 * NativeBackendSession 文件系统端口（ Stage 7a）。
 *
 * 实现由宿主注入（典型：`@tabtin/safe-fs` 包装），runtime 生产路径
 * 不再硬依赖 safe-fs / os-errors。
 */

export interface SafeFsStatLike {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtimeMs: number;
}

export interface SafeFsPort {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer | string): Promise<void>;
  readDir(path: string): Promise<string[]>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void | string | undefined>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  access(path: string, mode?: number): Promise<void>;
  stat(path: string): Promise<SafeFsStatLike>;
}

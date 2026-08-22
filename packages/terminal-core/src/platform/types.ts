import type { SpawnOptions } from 'node:child_process';
import type { SandboxLevel } from '../types';

/**
 * OS 沙箱 spawn 参数 — 传给 node:child_process.spawn()
 */
export interface SandboxSpawnArgs {
  file: string;
  args: string[];
  options: SpawnOptions;
}

/**
 * OS 沙箱输入参数
 */
export interface SandboxParams {
  command: string;
  cwd: string;           // sandbox projectDir（只读副本）
  tmpDir: string;         // 可写临时目录
  sandboxLevel: SandboxLevel;
  env: Record<string, string>;
  /** Network policy: "allowed" = no restriction, "blocked" = no network, "custom" = domain-based */
  networkMode?: 'allowed' | 'blocked' | 'custom';
}

/**
 * 平台沙箱适配器接口
 *
 * 每个平台（macOS / Linux）实现此接口，
 * 用 OS 原生沙箱工具包裹 spawn 调用。
 */
export interface PlatformSandbox {
  readonly platform: 'darwin' | 'linux' | 'windows' | 'unsupported';
  /** 检查平台沙箱工具是否可用（结果会被缓存） */
  isAvailable(): Promise<boolean>;
  /** 构造被沙箱包裹的 spawn 参数 */
  buildSpawnArgs(params: SandboxParams): SandboxSpawnArgs;
}

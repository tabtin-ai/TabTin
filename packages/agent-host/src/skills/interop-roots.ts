/**
 * 规范互操作 Skill 目录解析。
 *
 * 本机全局（device / interop）：
 * - `TABTIN_AGENTS_SKILLS_DIR` 或 `~/.agents/skills`
 * - `~/.cursor/skills` / `~/.claude/skills` / `~/.codex/skills`
 *
 * 工作区目录自带 Skill（Trust 注入）走 `workspace-skill-scanner` 按内容特征
 * 发现（含 `.agents/.cursor/.claude/.codex/skills`），不经本文件挂 device 根，
 * 避免与 `workspace:<rel>` 双登记。
 */

import * as os from 'node:os';
import * as path from 'node:path';

export const AGENTS_SKILLS_ENV = 'TABTIN_AGENTS_SKILLS_DIR';

/** 跨客户端约定的 skills 子路径（相对 home 或 working_dir）。 */
export const CLIENT_SKILL_DIR_SEGMENTS: ReadonlyArray<readonly string[]> = [
  ['.agents', 'skills'],
  ['.cursor', 'skills'],
  ['.claude', 'skills'],
  ['.codex', 'skills'],
];

/** 全局互操作根：env 覆盖优先，否则 `~/.agents/skills`。 */
export function resolveDefaultAgentsSkillsDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env[AGENTS_SKILLS_ENV]?.trim();
  if (override) return path.resolve(override);
  return path.join(homedir(), '.agents', 'skills');
}

/**
 * 本机全局多客户端互操作根（去重、保序）。
 * `TABTIN_AGENTS_SKILLS_DIR` 若设置，替换默认的 `~/.agents/skills` 槽位，其余客户端路径仍保留。
 */
export function resolveGlobalInteropSkillDirs(options?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): string[] {
  const env = options?.env ?? process.env;
  const homedir = options?.homedir ?? os.homedir;
  const home = homedir();
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (p: string) => {
    const normalized = path.resolve(p);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  push(resolveDefaultAgentsSkillsDir(env, homedir));
  for (const segments of CLIENT_SKILL_DIR_SEGMENTS) {
    // `.agents/skills` 已由 resolveDefaultAgentsSkillsDir（含 env 覆盖）处理
    if (segments[0] === '.agents' && segments[1] === 'skills') continue;
    push(path.join(home, ...segments));
  }
  return out;
}

/** 工作区级互操作根：`<workspaceRoot>/.agents/skills`（兼容旧调用）。 */
export function resolveWorkspaceAgentsSkillsDir(workspaceRoot: string): string | null {
  const dirs = resolveWorkspaceClientSkillDirs(workspaceRoot);
  return dirs[0] ?? null;
}

/**
 * 工作区下各客户端 skills 目录（目录可不存在——scanner / addInteropRoot 静默跳过）。
 * 注入链路请用 workspace-skill-scanner；本 API 仅供显式列举 / 测试。
 */
export function resolveWorkspaceClientSkillDirs(workspaceRoot: string): string[] {
  const trimmed = workspaceRoot?.trim();
  if (!trimmed) return [];
  const root = path.resolve(trimmed);
  return CLIENT_SKILL_DIR_SEGMENTS.map((segments) => path.join(root, ...segments));
}

/**
 * 组装 initSkillsModule 用的 interopRoots（去重、保序）。
 * 默认只含本机全局多客户端根；`workspaceRoots` 可选追加工作区客户端路径
 * （通常由宿主决定是否挂——#7676 注入走 W3 scanner，Electron 不再挂 working_dir）。
 */
export function resolveDefaultInteropRoots(options?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  workspaceRoots?: readonly string[];
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (p: string | null | undefined) => {
    if (!p) return;
    const normalized = path.resolve(p);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  for (const root of resolveGlobalInteropSkillDirs({
    env: options?.env,
    homedir: options?.homedir,
  })) {
    push(root);
  }
  for (const workspaceRoot of options?.workspaceRoots ?? []) {
    for (const dir of resolveWorkspaceClientSkillDirs(workspaceRoot)) {
      push(dir);
    }
  }
  return out;
}

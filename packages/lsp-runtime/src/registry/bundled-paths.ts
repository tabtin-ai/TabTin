/**
 * Bundled LSP server 路径解析。
 *
 * 三层 fallback（优先级从高到低）：
 *   1. `TABTIN_LSP_SERVERS_DIR` env override —— 测试 / 高级用户配置
 *   2. packaged 模式：`process.resourcesPath/app.asar.unpacked/lsp-servers/`
 *   3. dev 模式：`packages/lsp-runtime/lsp-servers/`
 *
 * Spawn 顺序（builtin-servers.ts 用）：
 *   1. `which(<bin>)` 系统 PATH —— 高级用户装了更新版
 *   2. bundled path —— TabTin 预置版本
 *
 *   TabTin 不走 plugin 系统，用 bundled + 静态注册。本设计是 TabTin 自有，
 *   解析逻辑见 `Module.resolve("typescript/lib/tsserver.js", ctx.directory)`
 *   + `Npm.which("typescript-language-server")` 的"先项目自带，再 bundled"思路。
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 解析 lsp-servers/ 根目录。
 *
 * 优先级：
 *   1. `TABTIN_LSP_SERVERS_DIR` env
 *   2. packaged（`process.resourcesPath` 存在且包含 app.asar.unpacked）
 *   3. dev（相对于本模块 `../../lsp-servers`）
 */
export function getLspServersRoot(): string {
  if (process.env.TABTIN_LSP_SERVERS_DIR) {
    return process.env.TABTIN_LSP_SERVERS_DIR;
  }

  // Packaged Electron：process.resourcesPath 指向 Electron 安装目录的 resources/
  // asarUnpack 的内容在 app.asar.unpacked/ 下
  const resPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resPath) {
    const packagedPath = join(resPath, 'app.asar.unpacked', 'lsp-servers');
    if (existsSync(packagedPath)) {
      return packagedPath;
    }
  }

  // Dev / monorepo：相对本模块 ../../lsp-servers（即 lsp-runtime 包根）
  // 编译后是 dist/index.js → ../lsp-servers
  // 源码模式是 src/registry/bundled-paths.ts → ../../lsp-servers
  // 两种位置都试一下
  const fromCompiled = resolve(__dirname, '..', 'lsp-servers');
  if (existsSync(fromCompiled)) return fromCompiled;

  return resolve(__dirname, '..', '..', 'lsp-servers');
}

/**
 * 找系统 PATH 中的 binary（高级用户优先级）。
 *
 * 返回完整路径或 undefined。
 */
export function which(bin: string): string | undefined {
  try {
    // 跨平台：macOS/Linux 用 `which`，Windows 用 `where`
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [bin], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const firstLine = out.split('\n')[0]?.trim();
    return firstLine && existsSync(firstLine) ? firstLine : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析 typescript-language-server 的 binary 路径（cli.mjs）。
 *
 * 优先级：系统 PATH > bundled。
 *
 * @returns spawn 参数：{ command: 'node', args: [cliPath, '--stdio'] }
 *          或 undefined 如果都找不到（由 agent-runtime 的 spawn linter fallback 兜底）。
 */
export function resolveTypescriptLanguageServer():
  | { command: string; args: string[] }
  | undefined {
  // 1. 系统 PATH（npm install -g 装的）
  const sysBin = which('typescript-language-server');
  if (sysBin) {
    return { command: sysBin, args: ['--stdio'] };
  }

  // 2. bundled
  const bundled = join(
    getLspServersRoot(),
    'typescript-language-server',
    'lib',
    'cli.mjs',
  );
  if (existsSync(bundled)) {
    // 用 process.execPath（Node binary）spawn cli.mjs
    return { command: process.execPath, args: [bundled, '--stdio'] };
  }

  return undefined;
}

/**
 * 解析项目使用的 tsserver.js（typescript-language-server 必需的 init option）。
 *
 * 优先级：项目自带 (node_modules/typescript) > bundled。
 *
 * @param projectRoot 项目根目录（用来 resolve 项目 node_modules）
 * @returns tsserver.js 绝对路径，或 undefined
 */
export function resolveTsserver(projectRoot: string): string | undefined {
  // 1. 项目自带 typescript（项目自带 typescript 优先解析）
  const projectTsserver = join(
    projectRoot,
    'node_modules',
    'typescript',
    'lib',
    'tsserver.js',
  );
  if (existsSync(projectTsserver)) {
    return projectTsserver;
  }

  // 2. bundled typescript
  const bundled = join(
    getLspServersRoot(),
    'typescript',
    'lib',
    'tsserver.js',
  );
  if (existsSync(bundled)) {
    return bundled;
  }

  return undefined;
}

/**
 * 解析 pyright-langserver 的 binary 路径。
 *
 * 优先级：系统 PATH > bundled。
 */
export function resolvePyrightLangserver():
  | { command: string; args: string[] }
  | undefined {
  // 1. 系统 PATH（pip install pyright 装的）
  const sysBin = which('pyright-langserver');
  if (sysBin) {
    return { command: sysBin, args: ['--stdio'] };
  }

  // 2. bundled（pyright 包提供 langserver.index.js）
  const bundled = join(getLspServersRoot(), 'pyright', 'langserver.index.js');
  if (existsSync(bundled)) {
    return { command: process.execPath, args: [bundled, '--stdio'] };
  }

  return undefined;
}

/**
 * 检测 Python 项目的 venv 路径（给 pyright 传 pythonPath initialization option 用）。
 *
 * venv 探测顺序（server.ts:501-513）：
 *   - $VIRTUAL_ENV
 *   - <projectRoot>/.venv
 *   - <projectRoot>/venv
 */
export function detectPythonInterpreter(
  projectRoot: string,
): string | undefined {
  const isWin = process.platform === 'win32';
  const pyRelPath = isWin ? ['Scripts', 'python.exe'] : ['bin', 'python'];

  const candidates = [
    process.env.VIRTUAL_ENV,
    join(projectRoot, '.venv'),
    join(projectRoot, 'venv'),
  ].filter((p): p is string => !!p);

  for (const venv of candidates) {
    const py = join(venv, ...pyRelPath);
    if (existsSync(py)) return py;
  }

  return undefined;
}

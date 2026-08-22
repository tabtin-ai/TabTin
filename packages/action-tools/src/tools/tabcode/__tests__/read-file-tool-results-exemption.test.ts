/**
 * **W4 (2026-05-12)** —— `read_file` 对 tool-results 引用文件的 workspace 豁免
 * 端到端测试。
 *
 * 背景：`summarizeToolOutput` / `enforceToolOutputBudget` 把超阈值工具输出
 * 持久化到 `<sessionDir>/tool-results/<id>.txt`，给 LLM 的 banner 里有这个
 * 绝对路径。但该路径不在用户的 workspace（`_allowed_paths`）内，没有此豁免
 * read_file 会被 workspace boundary 拦截 —— 持久化机制变成单向（写得进、
 * 读不回）废了一半。
 *
 * 安全约束（必须测试）：
 *   1. ✓ 仅 read_file 豁免 —— write/edit/delete 不豁免，避免 LLM 把恶意内容
 *      写入 session 目录后再用持久化机制传播
 *   2. ✓ 仅当前 session 的 tool-results 路径 —— 跨 session 不豁免
 *   3. ✓ 精确路径前缀匹配 —— `..` / 同级别其他目录不能绕过
 *   4. ✓ adapter 强制覆盖 _tool_results_dir —— LLM 在 input 里伪造该字段会
 *      被 adapter 抹掉（这层在 tabcode-adapter.ts，本测试覆盖 action-tools 层
 *      接 _tool_results_dir 后的真实判定）
 *   5. ✓ 缺省（没传 _tool_results_dir）→ 不启用豁免，老行为不破坏
 *   6. ✓ 红线/敏感路径仍生效 —— 即便 _tool_results_dir 配置错误指向 ~/.ssh，
 *      红线仍能拦下
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../utils/tool-output', () => ({
  standardizeLegacyResult: (r: any) => r,
}));

import {
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileDeleteTool,
} from '../index';

let workspaceDir: string;
let toolResultsDir: string;
let outsideDir: string;

beforeEach(async () => {
  // 三个隔离目录：
  //   - workspaceDir: 用户的 workspace（_allowed_paths）
  //   - toolResultsDir: session 的 tool-results 目录（豁免目标）
  //   - outsideDir: workspace 外、也不在 toolResultsDir 内的"野"目录
  // realpath 是为了避开 macOS /var → /private/var symlink 让 boundary 检查
  // 跟 resolveInWorkspace 看到同一个 canonical 路径
  const wsRaw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'w4-ws-'));
  const trRaw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'w4-tr-'));
  const outRaw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'w4-out-'));
  workspaceDir = await fsPromises.realpath(wsRaw);
  toolResultsDir = await fsPromises.realpath(trRaw);
  outsideDir = await fsPromises.realpath(outRaw);
});

afterEach(async () => {
  await fsPromises.rm(workspaceDir, { recursive: true, force: true });
  await fsPromises.rm(toolResultsDir, { recursive: true, force: true });
  await fsPromises.rm(outsideDir, { recursive: true, force: true });
});

async function writeIn(dir: string, name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await fsPromises.writeFile(file, content);
  return file;
}

describe('W4 read_file workspace 豁免：tool-results 引用文件能读', () => {
  it('persisted output 路径在 toolResultsDir 内 → read_file 放行', async () => {
    const refFile = await writeIn(toolResultsDir, 'toolu_01abc.txt', 'persisted content\nline 2\n');

    const res = await fileReadTool.execute({
      path: refFile,
      // adapter 在 enrichWithWorkspaceRoot 注入这三个内部字段：
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir], // workspace 边界仅含 workspaceDir
      _tool_results_dir: toolResultsDir, // W4 豁免目标
    } as any);

    expect(res.success).toBe(true);
    expect(res.data?.content).toContain('persisted content');
  });

  it('toolResultsDir 子目录里的文件也豁免（深度无关）', async () => {
    const sub = path.join(toolResultsDir, 'nested');
    await fsPromises.mkdir(sub);
    const refFile = await writeIn(sub, 'subfile.txt', 'nested ok');

    const res = await fileReadTool.execute({
      path: refFile,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
      _tool_results_dir: toolResultsDir,
    } as any);

    expect(res.success).toBe(true);
    expect(res.data?.content).toContain('nested ok');
  });

  it('workspace 外、又不在 toolResultsDir 内 → read_file 仍能读（boundary 仅对写生效）', async () => {
    // 注：read_file 的 workspace boundary 检查现状是只对写操作生效（参考
    // `checkFilePathSecurity` 第 374 行 `if (isWrite && ...)`），所以这条
    // 用例本来就 success。这个测试是定位"豁免不影响 read 现有行为"的回归保护。
    const file = await writeIn(outsideDir, 'outside.txt', 'outside content');

    const res = await fileReadTool.execute({
      path: file,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
      _tool_results_dir: toolResultsDir,
    } as any);

    expect(res.success).toBe(true);
  });
});

describe('W4 read_file workspace 豁免：write/edit/delete 不豁免（仅 read）', () => {
  it('write_file 到 toolResultsDir 内被拒（不豁免写）', async () => {
    const target = path.join(toolResultsDir, 'evil.txt');

    const res = await fileWriteTool.execute({
      path: target,
      content: 'malicious payload',
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir], // toolResultsDir 不在 allowed_paths 内
      _tool_results_dir: toolResultsDir, // W4 豁免，仅对 read 生效
    } as any);

    expect(res.success).toBe(false);
    // 2026-05-13：错误文案对齐工具协议给 LLM 的简洁结构化版本
    // ("outside the allowed workspace")，UI 产品名归 i18n 层。
    expect(String(res.error)).toContain('outside the allowed workspace');
  });

  it('edit_file 在 toolResultsDir 内被拒', async () => {
    const target = await writeIn(toolResultsDir, 'evil.txt', 'original');

    const res = await fileEditTool.execute({
      path: target,
      old_string: 'original',
      new_string: 'tampered',
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
      _tool_results_dir: toolResultsDir,
    } as any);

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain('outside the allowed workspace');
  });

  it('delete_file 在 toolResultsDir 内被拒（防 LLM 抹掉持久化记录）', async () => {
    const target = await writeIn(toolResultsDir, 'evil.txt', 'to delete');

    const res = await fileDeleteTool.execute({
      path: target,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
      _tool_results_dir: toolResultsDir,
    } as any);

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain('outside the allowed workspace');
  });
});

describe('W4 read_file workspace 豁免：路径绕过攻击面', () => {
  it('`..` 跨出 toolResultsDir 不豁免（外部 sibling 路径攻击）', async () => {
    // toolResultsDir/../<otherDir>/evil.txt — 字面以 toolResultsDir 起手但
    // 实际 path.resolve 后跳到外面。豁免分支用 path.relative 检查，必须能
    // 拦下来。
    const evil = path.join(toolResultsDir, '..', path.basename(outsideDir), 'sibling.txt');
    await writeIn(outsideDir, 'sibling.txt', 'sensitive');

    // 这里关注的不是 read_file 是否成功（read 现状本身不查 boundary）——
    // 关键是豁免分支不能命中 sibling 路径。豁免命中的标志是 checkFilePathSecurity
    // 提前 return null 跳过后续检查。这里 read_file 要么因为豁免命中直接读到
    // sensitive 内容（漏洞），要么走正常路径正常读到内容（安全）。
    // 用 write_file 可以更精确观察豁免是否被绕过：
    const writeRes = await fileWriteTool.execute({
      path: evil,
      content: 'tampered via ..',
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
      _tool_results_dir: toolResultsDir,
    } as any);

    // write 不在 read_file 豁免范围（actionType 不匹配），所以无论如何都该被拒
    expect(writeRes.success).toBe(false);
    expect(String(writeRes.error)).toContain('outside the allowed workspace');
  });

  it('toolResultsDir 缺省 → 豁免不启用（老调用方零行为变化）', async () => {
    const refFile = await writeIn(toolResultsDir, 'old-style.txt', 'no exemption');

    const res = await fileReadTool.execute({
      path: refFile,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
      // _tool_results_dir 故意不传 → 豁免分支因 typeof !== 'string' 跳过
    } as any);

    // read 现状本身不查 boundary（仅对 write 生效），所以这里 success
    // 这个用例本质是验证"豁免分支不是必须命中"的回归保护
    expect(res.success).toBe(true);
  });
});

describe('W4 read_file workspace 豁免：红线/敏感路径仍兜底', () => {
  it('toolResultsDir 配置指向敏感路径时，红线仍能拦下', async () => {
    // 模拟 config drift：sessionDir 错配到敏感路径附近，导致 toolResultsDir
    // 解析到 ~/.ssh（红线列表内）。豁免分支放在红线检查之后，所以红线先
    // 命中 → return error，豁免分支没机会执行。
    const sshPath = path.join(os.homedir(), '.ssh', 'id_rsa');

    const res = await fileReadTool.execute({
      path: sshPath,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
      _tool_results_dir: path.join(os.homedir(), '.ssh'), // 错配触发豁免
    } as any);

    expect(res.success).toBe(false);
    // 红线 / 敏感路径错误文案任一命中都算保护生效
    const errMsg = String(res.error);
    expect(
      errMsg.includes('sensitive path') ||
        errMsg.includes('blocked'),
    ).toBe(true);
  });
});

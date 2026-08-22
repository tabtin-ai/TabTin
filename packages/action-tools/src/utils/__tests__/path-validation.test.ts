/**
 * 路径权限治理 W1 遗留 L2 / Wave 2：`validateProjectPath` 行为钉死。
 *
 * 三组诉求：
 *   1. write 分支已有 `alreadyJudged` 跳过（W1 已实装），此处补回归
 *   2. **read 分支接 `alreadyJudged` 跳过 boundary**（L2 本 wave 修）
 *   3. 红线（HARD_DENY_READ_PHYSICAL + matchSensitivePath）必须**先于**
 *      `alreadyJudged` 跳过执行——judge 已通过仅意味着"工作区/yolo/memo
 *      决策放行"，不等于"`/etc/shadow` 解锁"
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';

import { validateProjectPath } from '../path-validation';

const HOME = os.homedir();

async function makeTempDir(prefix = 'pv-test-'): Promise<string> {
  return await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('validateProjectPath: write 分支（W1 回归 + L2 行为对齐）', () => {
  it('boundary 命中 → 抛 outside-workspace 错', async () => {
    const tmp = await makeTempDir();
    expect(() => {
      validateProjectPath('write', '/var/no-such-dir/file', {
        workspaceRoots: [tmp],
        platformDataRoot: '/var/empty',
      });
      // 2026-05-13：错误文案对齐工具协议给 LLM 的简洁版（去除 UI 产品名词
      // "TabFolder/TabCode" / "Super Permissions"）。前端 i18n 基于 error_code
      // 渲染产品语言。
    }).toThrow(/outside the allowed workspace/i);
    await fsPromises.rm(tmp, { recursive: true }).catch(() => {});
  });

  it('alreadyJudged=true → 跳过 boundary 检查', async () => {
    const tmp = await makeTempDir();
    expect(() => {
      validateProjectPath('write', '/var/no-such-dir/file', {
        workspaceRoots: [tmp],
        platformDataRoot: '/var/empty',
        alreadyJudged: true,
      });
    }).not.toThrow();
    await fsPromises.rm(tmp, { recursive: true }).catch(() => {});
  });

  it('alreadyJudged=true 仍被红线（/etc/shadow）拒', () => {
    expect(() => {
      validateProjectPath('write', '/etc/shadow', {
        workspaceRoots: ['/'],
        platformDataRoot: '/var/empty',
        alreadyJudged: true,
      });
    }).toThrow(/protected system path/i);
  });

  it('alreadyJudged=true 仍被 matchSensitivePath 拒（~/.ssh/id_rsa）', () => {
    const sshKey = path.join(HOME, '.ssh', 'id_rsa');
    expect(() => {
      validateProjectPath('write', sshKey, {
        workspaceRoots: ['/'],
        platformDataRoot: '/var/empty',
        alreadyJudged: true,
      });
    }).toThrow(/protected system path/i);
  });
});

describe('validateProjectPath: read 分支 alreadyJudged 接通（L2 修复）', () => {
  it('boundary 命中（路径不在 workspaceRoots / platformDataRoot 内） → 抛 outside-allowed 错', async () => {
    const tmp = await makeTempDir();
    expect(() => {
      validateProjectPath('read', '/var/no-such-dir/file', {
        workspaceRoots: [tmp],
        platformDataRoot: '/var/empty',
      });
    }).toThrow(/outside allowed/i);
    await fsPromises.rm(tmp, { recursive: true }).catch(() => {});
  });

  it('alreadyJudged=true → 跳过 boundary（与 write 对称）', async () => {
    const tmp = await makeTempDir();
    expect(() => {
      validateProjectPath('read', '/var/no-such-dir/file', {
        workspaceRoots: [tmp],
        platformDataRoot: '/var/empty',
        alreadyJudged: true,
      });
    }).not.toThrow();
    await fsPromises.rm(tmp, { recursive: true }).catch(() => {});
  });

  it('alreadyJudged=true 仍被红线（/etc/shadow）拒——红线先于跳过', () => {
    expect(() => {
      validateProjectPath('read', '/etc/shadow', {
        workspaceRoots: ['/'],
        platformDataRoot: '/var/empty',
        alreadyJudged: true,
      });
    }).toThrow(/protected system path/i);
  });

  it('alreadyJudged=true 仍被 matchSensitivePath 拒（~/.ssh/id_rsa）', () => {
    const sshKey = path.join(HOME, '.ssh', 'id_rsa');
    expect(() => {
      validateProjectPath('read', sshKey, {
        workspaceRoots: ['/'],
        platformDataRoot: '/var/empty',
        alreadyJudged: true,
      });
    }).toThrow(/protected system path/i);
  });

  it('alreadyJudged=false（缺省）+ 路径在 workspaceRoots 内 → 通过', async () => {
    const tmp = await makeTempDir();
    const target = path.join(tmp, 'a.txt');
    fs.writeFileSync(target, 'hi');
    expect(() => {
      validateProjectPath('read', target, {
        workspaceRoots: [tmp],
        platformDataRoot: '/var/empty',
      });
    }).not.toThrow();
    await fsPromises.rm(tmp, { recursive: true }).catch(() => {});
  });

  it('alreadyJudged=false + 逻辑路径在 workspace 内但 path = /etc/passwd → matchSensitivePath 拒', async () => {
    // 工作区内不能用 absolute /etc/passwd 作为 path（不在 workspaceRoots 范围）；
    // 这里直接传绝对路径，验证敏感路径黑名单先于 workspace boundary 跑。
    expect(() => {
      validateProjectPath('read', '/etc/passwd', {
        workspaceRoots: ['/'],
        platformDataRoot: '/var/empty',
      });
    }).toThrow(/protected system path/i);
  });
});

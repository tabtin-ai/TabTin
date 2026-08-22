/**
 * W6 M3 收 L-M3-R4 的 type guard 回归门禁。
 *
 * 这份测试钉死 `TabTinDaemon.decodeWorkspaceSnapshot` 五条契约 ——
 * PD-14 方案 A 链路上 Daemon 端「主控端透传 workspace_snapshot 解 wire payload」
 * 的稳健性兜底。在 dogfood-daemon-yolo.sh 场景 3 之外补一层 type guard 单元覆盖：
 *
 *   1. 合法完整 payload → 正确 reshape 为 `WorkspaceSnapshot`
 *   2. raw 不是合法 object（null / undefined / array / primitive）→ undefined
 *   3. 缺关键字段（sources / allowedPaths / spaceSessionId 任一）→ undefined
 *   4. sources 内字段类型错（sandbox 非 string / 数组含非 string）→ 空字符串 / filter 掉
 *   5. allowedFiles 缺失 / 非数组 → 空数组兜底（保证 `WorkspaceSnapshot` shape 完整）
 *
 * 形态错误统一退化到 `undefined`（让 daemon 走 sandbox-only 兜底，与未传等价），
 * 不抛错 —— 跟上游 `chat_send_message` handler 注释里"不强校验形态"契约对齐
 * （详见 `apps/tabtin_django/apps/services/common/ws/handlers/chat_send_message.py`
 * 的 L-W6-02 段）。
 *
 * 不验证下游 `buildPolicyFromAgentConfigV2` 行为（那是 security-policy 包的范围），
 * 也不验证 `routeToLocalAgentHost` 装配 `localAgentHost.handleQuery`（那是
 * dogfood-daemon-yolo.sh 场景 3 的端到端覆盖）；只验证 wire decode → object shape
 * 在协议层升级后仍正确。
 */
import { describe, expect, it } from 'vitest';
import type { WorkspaceSnapshot } from '@tabtin/security-policy';
import { decodeForwardWorkspaceSnapshot } from '@tabtin/agent-host/conversation';

interface DecodeHarness {
  decodeWorkspaceSnapshot: (raw: unknown) => WorkspaceSnapshot | undefined;
}

function createDecoder(): DecodeHarness {
  return { decodeWorkspaceSnapshot: decodeForwardWorkspaceSnapshot };
}

describe('TabTinDaemon · decodeWorkspaceSnapshot (W6 M3 收 L-M3-R4)', () => {
  it('完整合法 payload → 正确 reshape', () => {
    const decoder = createDecoder();
    const result = decoder.decodeWorkspaceSnapshot({
      sources: {
        sandbox: '/Users/me/.tabtin/sandbox',
        tabcodeProjects: ['/Users/me/dev/midscene', '/Users/me/dev/playground'],
        tabfolderDirs: ['/Users/me/Documents/work'],
        attachedFiles: ['/Users/me/Downloads/brief.md'],
      },
      allowedPaths: [
        '/Users/me/.tabtin/sandbox',
        '/Users/me/dev/midscene',
        '/Users/me/Documents/work',
      ],
      allowedFiles: ['/Users/me/Downloads/brief.md'],
      spaceSessionId: 'space-session-abc-123',
    });

    expect(result).toBeDefined();
    expect(result?.sources.sandbox).toBe('/Users/me/.tabtin/sandbox');
    // 单根契约：sources 现在只有 sandbox + workingDir + attachedFiles。
    // wire 上的老 tabcodeProjects 数组被 decode 忽略，不再消费。
    expect(result?.sources.workingDir).toBe('');
    expect(result?.sources.attachedFiles).toEqual(['/Users/me/Downloads/brief.md']);
    expect(result?.allowedPaths).toEqual([
      '/Users/me/.tabtin/sandbox',
      '/Users/me/dev/midscene',
      '/Users/me/Documents/work',
    ]);
    expect(result?.allowedFiles).toEqual(['/Users/me/Downloads/brief.md']);
    expect(result?.spaceSessionId).toBe('space-session-abc-123');
  });

  describe('raw 不是合法 object → undefined（fail-soft 退化 sandbox-only）', () => {
    const decoder = createDecoder();

    it('null', () => {
      expect(decoder.decodeWorkspaceSnapshot(null)).toBeUndefined();
    });

    it('undefined', () => {
      expect(decoder.decodeWorkspaceSnapshot(undefined)).toBeUndefined();
    });

    it('array', () => {
      // Array 是 object，但语义上不是 WorkspaceSnapshot —— 必须拦下
      expect(decoder.decodeWorkspaceSnapshot(['/foo', '/bar'])).toBeUndefined();
    });

    it('string primitive', () => {
      expect(decoder.decodeWorkspaceSnapshot('/Users/me/dev')).toBeUndefined();
    });

    it('number primitive', () => {
      expect(decoder.decodeWorkspaceSnapshot(42)).toBeUndefined();
    });

    it('boolean primitive', () => {
      expect(decoder.decodeWorkspaceSnapshot(true)).toBeUndefined();
    });
  });

  describe('缺关键字段 → undefined（与"未传"等价）', () => {
    const decoder = createDecoder();

    it('缺 sources', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        allowedPaths: ['/foo'],
        spaceSessionId: 'sess-1',
      });
      expect(result).toBeUndefined();
    });

    it('缺 allowedPaths', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/foo', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
        spaceSessionId: 'sess-1',
      });
      expect(result).toBeUndefined();
    });

    it('缺 spaceSessionId', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/foo', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['/foo'],
      });
      expect(result).toBeUndefined();
    });

    it('sources 是 array（非 object）', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: ['/foo'],
        allowedPaths: ['/foo'],
        spaceSessionId: 'sess-1',
      });
      expect(result).toBeUndefined();
    });

    it('allowedPaths 是 string（非 array）', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/foo', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: '/foo',
        spaceSessionId: 'sess-1',
      });
      expect(result).toBeUndefined();
    });

    it('spaceSessionId 是 number（非 string）', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/foo', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['/foo'],
        spaceSessionId: 12345,
      });
      expect(result).toBeUndefined();
    });
  });

  describe('字段类型错 → 安全兜底（保 shape 完整，不抛错）', () => {
    const decoder = createDecoder();

    it('sources.sandbox 非 string → 空字符串', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: {
          sandbox: 12345, // 非 string
          tabcodeProjects: [],
          tabfolderDirs: [],
          attachedFiles: [],
        },
        allowedPaths: ['/some/path'],
        spaceSessionId: 'sess-1',
      });
      expect(result).toBeDefined();
      expect(result?.sources.sandbox).toBe('');
    });

    it('sources.tabcodeProjects 含非 string 元素 → filter 掉', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: {
          sandbox: '/foo',
          tabcodeProjects: ['/valid/path', 42, null, '/another/valid'],
          tabfolderDirs: [],
          attachedFiles: [],
        },
        allowedPaths: ['/some/path'],
        spaceSessionId: 'sess-1',
      });
      // 单根契约：sources 不再有 tabcodeProjects 字段；wire 里残留的数组被 decode 忽略
      expect(result?.sources.workingDir).toBe('');
    });

    it('sources.tabcodeProjects 字段已废弃，wire 上残留任何形态都被忽略', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: {
          sandbox: '/foo',
          tabcodeProjects: '/single/path', // 非 array，老 wire 形态错乱
          tabfolderDirs: [],
          attachedFiles: [],
        },
        allowedPaths: ['/some/path'],
        spaceSessionId: 'sess-1',
      });
      // sources 不再有 tabcodeProjects 字段
      expect(result?.sources.workingDir).toBe('');
    });

    it('allowedPaths 含非 string 元素 → filter 掉', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/foo', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['/valid', 999, undefined, '/also-valid'],
        spaceSessionId: 'sess-1',
      });
      expect(result?.allowedPaths).toEqual(['/valid', '/also-valid']);
    });
  });

  describe('allowedFiles 兜底（缺 / 非 array → 空数组保 shape）', () => {
    const decoder = createDecoder();

    it('缺 allowedFiles → 空数组', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/foo', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['/foo'],
        spaceSessionId: 'sess-1',
      });
      expect(result?.allowedFiles).toEqual([]);
    });

    it('allowedFiles 非 array → 空数组', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/foo', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['/foo'],
        allowedFiles: '/single/file',
        spaceSessionId: 'sess-1',
      });
      expect(result?.allowedFiles).toEqual([]);
    });

    it('allowedFiles 含非 string 元素 → filter 掉', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/foo', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['/foo'],
        allowedFiles: ['/valid/file', 42, '/another/valid'],
        spaceSessionId: 'sess-1',
      });
      expect(result?.allowedFiles).toEqual(['/valid/file', '/another/valid']);
    });
  });

  // ─── M3.1 硬化补丁：过宽 allowedPath 防护 ──────────────────────────
  //
  // 北极星：远程 Daemon 拿到的 `workspace_snapshot.allowedPaths` 里绝对不能
  // 有 `/` 或等价的"整盘"路径让整个家目录都变成 workspace。即使主控端
  // 代码 bug / 测试 fixture 泄漏 / WS 中间人篡改导致 wire payload 含畸形
  // path，Daemon 也要 fail-closed 到 sandbox，而不是信。
  describe('M3.1 硬化：过宽 allowedPath 防护', () => {
    const decoder = createDecoder();

    it('allowedPaths 含 `/` + 合法项目 → 过滤 `/` 保留合法项目', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/Users/me/.tabtin/sandbox', tabcodeProjects: ['/Users/me/dev/midscene'], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['/', '/Users/me/.tabtin/sandbox', '/Users/me/dev/midscene'],
        spaceSessionId: 'sess-1',
      });
      expect(result).toBeDefined();
      expect(result?.allowedPaths).toEqual(['/Users/me/.tabtin/sandbox', '/Users/me/dev/midscene']);
      // sandbox 字段合法，不被清空
      expect(result?.sources.sandbox).toBe('/Users/me/.tabtin/sandbox');
    });

    it('allowedPaths 全是过宽 path → 返回 undefined（fail-closed 退化 sandbox 兜底）', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/Users/me/.tabtin/sandbox', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['/', '/Users', '/home'],
        spaceSessionId: 'sess-1',
      });
      expect(result).toBeUndefined();
    });

    it('allowedPaths 含 /Users（顶级用户根） → filter 掉', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/Users/me/.tabtin/sandbox', tabcodeProjects: ['/Users/me/dev/proj'], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['/Users', '/Users/me/dev/proj'],
        spaceSessionId: 'sess-1',
      });
      expect(result?.allowedPaths).toEqual(['/Users/me/dev/proj']);
    });

    it('M3.1.1 方向 C：allowedPaths 含家目录本身 `/Users/developer` → 保留（撤 isUserHomeRoot 后合法）', () => {
      // M3.1.1 起：单用户家目录 /Users/<name> 视为合法 workspace
      // （用户拍板方向 C：放宽家目录但用 sensitive_path_list 把凭据子目录敲门补回）
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/Users/developer/.tabtin/sandbox', tabcodeProjects: ['/Users/developer'], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['/Users/developer', '/Users/developer/dev/proj'],
        spaceSessionId: 'sess-1',
      });
      expect(result?.allowedPaths).toEqual(['/Users/developer', '/Users/developer/dev/proj']);
    });

    it('allowedPaths 含相对路径 / `~` / 空串 → filter 掉', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/Users/me/.tabtin/sandbox', tabcodeProjects: ['/Users/me/dev/proj'], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['', '../../..', '~', '~/dev', 'dev/foo', '/Users/me/dev/proj'],
        spaceSessionId: 'sess-1',
      });
      expect(result?.allowedPaths).toEqual(['/Users/me/dev/proj']);
    });

    it('allowedPaths 含 Windows 盘符根 → filter 掉', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/Users/me/.tabtin/sandbox', tabcodeProjects: ['/Users/me/dev/proj'], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['C:/', 'C:\\', '/C:/', 'D:/', '/Users/me/dev/proj'],
        spaceSessionId: 'sess-1',
      });
      expect(result?.allowedPaths).toEqual(['/Users/me/dev/proj']);
    });

    it('sandbox 字段是 `/Users` → 清空（让 host 兜底推导）', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/Users', tabcodeProjects: ['/Users/me/dev/proj'], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['/Users/me/dev/proj'],
        spaceSessionId: 'sess-1',
      });
      expect(result?.sources.sandbox).toBe('');
    });

    it('sources.tabcodeProjects 字段已废弃，wire 上的过宽路径数组被 decode 忽略', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/Users/me/.tabtin/sandbox', tabcodeProjects: ['/', '/Users', '/Users/me/dev/proj'], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['/Users/me/dev/proj'],
        spaceSessionId: 'sess-1',
      });
      // sources 不再有 tabcodeProjects 字段；wire 数组无论是否过宽都不会进 sources
      expect(result?.sources.workingDir).toBe('');
    });

    it('allowedFiles 含过宽 path → filter 掉', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/Users/me/.tabtin/sandbox', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: ['/Users/me/Downloads/brief.md'] },
        allowedPaths: ['/Users/me/.tabtin/sandbox'],
        allowedFiles: ['/', '/Users', '/Users/me/Downloads/brief.md'],
        spaceSessionId: 'sess-1',
      });
      expect(result?.allowedFiles).toEqual(['/Users/me/Downloads/brief.md']);
    });

    it('过滤前已空 allowedPaths → 保留 shape-complete 空（合法"无项目"语义；区别于"全是畸形过滤后空"）', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: { sandbox: '/Users/me/.tabtin/sandbox', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: [],
        allowedFiles: [],
        spaceSessionId: 'sess-1',
      });
      // 过滤前空 → 不视为"被毒化"，让 mutate 层"empty as omit"防御处理
      expect(result).toBeDefined();
      expect(result?.allowedPaths).toEqual([]);
    });

    it('完整合法 payload 不被误挡（正例验证 M3.1 不破坏既有路径）', () => {
      const result = decoder.decodeWorkspaceSnapshot({
        sources: {
          sandbox: '/Users/developer/.tabtin/sandbox',
          tabcodeProjects: ['/Users/developer/dev/midscene', '/Users/developer/dev/playground'],
          tabfolderDirs: ['/Users/developer/Documents/work'],
          attachedFiles: ['/Users/developer/Downloads/brief.md'],
        },
        allowedPaths: [
          '/Users/developer/.tabtin/sandbox',
          '/Users/developer/dev/midscene',
          '/Users/developer/dev/playground',
          '/Users/developer/Documents/work',
        ],
        allowedFiles: ['/Users/developer/Downloads/brief.md'],
        spaceSessionId: 'sess-1',
      });
      expect(result).toBeDefined();
      expect(result?.allowedPaths).toEqual([
        '/Users/developer/.tabtin/sandbox',
        '/Users/developer/dev/midscene',
        '/Users/developer/dev/playground',
        '/Users/developer/Documents/work',
      ]);
      expect(result?.sources.sandbox).toBe('/Users/developer/.tabtin/sandbox');
    });
  });
});

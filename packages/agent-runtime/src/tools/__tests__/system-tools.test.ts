import { describe, expect, it, vi } from 'vitest';
import { createSystemTools } from '../system-tools.js';
import { OSErrorBlacklist } from '../../permissions/os-error-blacklist.js';
import type {
  ToolContext,
  ToolResult,
} from '../../engine/contracts/tools.js';

const ctx = {} as ToolContext;

function parseResult(r: ToolResult): { status: string; [k: string]: unknown } {
  return typeof r.content === 'string'
    ? JSON.parse(r.content)
    : { status: 'unknown' };
}

describe('createSystemTools', () => {
  it('注册两个工具：relaunch_app + clear_os_error_blacklist', () => {
    const tools = createSystemTools({});
    expect(tools.map((t) => t.name)).toEqual([
      'relaunch_app',
      'clear_os_error_blacklist',
    ]);
  });

  // 命名约束（dogfood P0 修复）：工具名必须满足 LLM 上游正则
  // `^[a-zA-Z0-9_-]{1,64}$`，旧名 `system.xxx` 已改为 snake_case `system_xxx`。
  it('工具名满足 LLM 上游正则（不允许点号 / CJK / 空格）', () => {
    const tools = createSystemTools({});
    const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
    for (const t of tools) {
      expect(t.name).toMatch(TOOL_NAME_RE);
      expect(t.name).not.toContain('.');
    }
  });

  describe('relaunch_app', () => {
    it('未注入 relaunchApp → unsupported_in_this_runtime（Daemon 部署语义）+ isError:false', async () => {
      // Wave 1 第二轮修订：Daemon 模式下没有 Electron app.relaunch()——重启
      // 由系统服务管理器（launchd / systemd / Windows 服务）控制。这不是
      // "工具坏了"，而是部署模式的硬约束。`isError: false` 让 LLM 把消息
      // 讲给用户后不再反复尝试（isError:true 会触发某些 LLM 的"工具失败
      // 自动重试"模式，反而把用户搞糊涂）。
      //
      // M-6 修订：文案拆 user_message（给用户听的人话）+ technical_note
      // （LLM 自己的内部上下文，含工程术语）。
      const [tool] = createSystemTools({});
      const r = await tool.execute({ reason: 'user authorized' }, ctx);
      expect(r.isError).toBe(false);
      const parsed = parseResult(r);
      expect(parsed.status).toBe('unsupported_in_this_runtime');
      expect(parsed.runtime).toBe('daemon');
      // user_message 是给用户听的人话——不含 launchd / systemd 等术语
      const userMsg = parsed.user_message as string;
      expect(userMsg).toContain('TabTin');
      expect(userMsg).toContain('手动重启');
      expect(userMsg).not.toContain('launchd');
      expect(userMsg).not.toContain('systemd');
      expect(userMsg).not.toContain('clear_os_error_blacklist');
      // technical_note 是给 LLM 自己看的——可以含工程术语，引导后续决策
      const techNote = parsed.technical_note as string;
      expect(techNote).toContain('launchd');
      expect(techNote).toContain('clear_os_error_blacklist');
    });

    it('注入 relaunchApp → 触发 + 返回 restarting 状态', async () => {
      const relaunchApp = vi.fn().mockResolvedValue(undefined);
      const [tool] = createSystemTools({ relaunchApp });
      const r = await tool.execute({ reason: 'user granted TCC' }, ctx);
      expect(r.isError).toBeFalsy();
      expect(parseResult(r).status).toBe('restarting');
      // relaunchApp 是 fire-and-forget，等一个 microtask 让它执行
      await new Promise((res) => setImmediate(res));
      expect(relaunchApp).toHaveBeenCalledOnce();
    });

    it('beforeRelaunch 抛错 → aborted 且不调 relaunchApp', async () => {
      const relaunchApp = vi.fn();
      const beforeRelaunch = vi.fn().mockRejectedValue(new Error('busy'));
      const [tool] = createSystemTools({ relaunchApp, beforeRelaunch });
      const r = await tool.execute({ reason: 'x' }, ctx);
      expect(r.isError).toBe(true);
      expect(parseResult(r).status).toBe('aborted');
      expect(relaunchApp).not.toHaveBeenCalled();
    });

    // Wave 1 第二轮 用户视角 Review 必修：beforeRelaunch 抛错时，原实现把
    // err.message 拼到对话内容（如 "Pre-relaunch hook failed: relaunch_aborted_by_user"）
    // 让 LLM 直接念给用户。修订：区分"用户主动取消"vs"未知错误"，分别给中文
    // user_message；技术视角 Review 要求"未知错误不暴露 message"避免泄漏栈。
    it('beforeRelaunch 抛 relaunch_aborted_by_user → 中文用户取消文案（jsonError envelope）', async () => {
      const relaunchApp = vi.fn();
      const beforeRelaunch = vi.fn().mockRejectedValue(new Error('relaunch_aborted_by_user'));
      const [tool] = createSystemTools({ relaunchApp, beforeRelaunch });
      const r = await tool.execute({ reason: '授权后重启' }, ctx);
      const parsed = parseResult(r);
      // W13：metadata 仍含 user_cancelled / technical_note；message 上提到 envelope `error` 字段
      expect(parsed.user_cancelled).toBe(true);
      const userMsg = parsed.error as string;
      expect(userMsg).toContain('点了取消');
      expect(userMsg).not.toContain('relaunch_aborted_by_user');
      expect(userMsg).not.toContain('hook');
    });

    it('beforeRelaunch 抛未知错误 → 受控中文兜底，不暴露内部 message', async () => {
      const relaunchApp = vi.fn();
      // 模拟非取消错误：路径泄漏 / stack / 内部状态
      const beforeRelaunch = vi.fn().mockRejectedValue(
        new Error('IPC pipe broken at /tmp/sock123 fd=42'),
      );
      const [tool] = createSystemTools({ relaunchApp, beforeRelaunch });
      const r = await tool.execute({ reason: 'x' }, ctx);
      const parsed = parseResult(r);
      expect(parsed.user_cancelled).toBe(false);
      const userMsg = parsed.error as string;
      // 关键：不能把内部 message 泄漏到 LLM-visible content（技术视角 Review 必修）
      expect(userMsg).not.toContain('IPC');
      expect(userMsg).not.toContain('/tmp/sock123');
      expect(userMsg).not.toContain('fd=42');
      expect(userMsg).not.toContain('pipe');
      // technical_note 也不暴露
      const techNote = parsed.technical_note as string;
      expect(techNote).not.toContain('/tmp/sock123');
      expect(techNote).not.toContain('fd=42');
    });

    // Wave 1 第二轮 用户视角 Review 必修：原英文 message "TabTin is restarting..."
    // 改为中文 user_message + 英文 technical_note 分层。
    it('relaunchApp 成功路径含中文 user_message 让 LLM 直接念', async () => {
      const relaunchApp = vi.fn().mockResolvedValue(undefined);
      const [tool] = createSystemTools({ relaunchApp });
      const r = await tool.execute({ reason: 'TCC granted' }, ctx);
      const parsed = parseResult(r);
      expect(parsed.status).toBe('restarting');
      const userMsg = parsed.user_message as string;
      expect(userMsg).toContain('TabTin');
      expect(userMsg).toContain('重启');
      // 不含工程术语 / 工具名（不该被念给用户）
      expect(userMsg).not.toContain('app.relaunch');
      expect(userMsg).not.toContain('Agent session');
    });
  });

  describe('clear_os_error_blacklist', () => {
    // Wave 1 第二轮 用户视角 + 产品视角 Review 必修：
    //   - 原实现 isError:true + 英文 "This host did not wire..." 让 LLM 中英混杂
    //     讲给用户，且 isError:true 触发某些 LLM 反复改参数重试
    //   - 修订：与 relaunchApp 缺省（非错误 + 中文 user_message + isError:false）
    //     对称——"无黑名单模式直接重试"是部署模式约束不是工具坏了
    it('未注入 blacklist → unsupported_in_this_runtime + isError:false + 中文 user_message', async () => {
      const [, tool] = createSystemTools({});
      const r = await tool.execute({ path: '/x', reason: 'r' }, ctx);
      expect(r.isError).toBe(false);
      const parsed = parseResult(r);
      expect(parsed.status).toBe('unsupported_in_this_runtime');
      const userMsg = parsed.user_message as string;
      expect(userMsg).toContain('重试'); // 让用户/LLM 知道直接重试就行
      expect(userMsg).not.toContain('blacklist'); // 不暴露技术术语
      expect(userMsg).not.toContain('host'); // 不暴露技术术语
    });

    it('清掉指定 path 的所有 code', async () => {
      const bl = new OSErrorBlacklist();
      bl.block('/x', 'A', 'm');
      bl.block('/x', 'B', 'm');
      bl.block('/y', 'A', 'm');
      const [, tool] = createSystemTools({ osErrorBlacklist: bl });
      const r = await tool.execute({ path: '/x', reason: 'user fixed' }, ctx);
      expect(r.isError).toBeFalsy();
      const parsed = parseResult(r);
      expect(parsed.status).toBe('ok');
      expect(parsed.cleared_entries).toBe(2);
      expect(bl.isBlocked('/x')).toBeNull();
      expect(bl.isBlocked('/y')).not.toBeNull();
    });

    it('path 缺失 → error', async () => {
      const bl = new OSErrorBlacklist();
      const [, tool] = createSystemTools({ osErrorBlacklist: bl });
      const r = await tool.execute({ reason: 'r' }, ctx);
      expect(r.isError).toBe(true);
    });

    // P0-1 修复：tool-orchestration 写入的是 toolCall 维度 + originalPath，
    // 用户在 LLM 对话里调 system.clear({ path: '~/Desktop' }) 必须命中。
    it('清掉 toolCall 维度（带 originalPath）写入的条目', async () => {
      const bl = new OSErrorBlacklist();
      // 模拟 tool-orchestration.maybeBlockToolOnOSError 写入的样子
      bl.blockToolCall(
        'read_file',
        { path: '/Users/foo/Desktop/x.txt' },
        'OS_PERMISSION_DENIED',
        'cached llm message — go grant Desktop access',
        undefined,
        '/Users/foo/Desktop/x.txt',
      );
      const [, tool] = createSystemTools({ osErrorBlacklist: bl });
      const r = await tool.execute(
        { path: '/Users/foo/Desktop/x.txt', reason: '用户已授权' },
        ctx,
      );
      expect(r.isError).toBeFalsy();
      const parsed = parseResult(r);
      expect(parsed.cleared_entries).toBe(1);
      // 后续工具调用应当不再短路
      expect(
        bl.isToolCallBlocked('read_file', { path: '/Users/foo/Desktop/x.txt' }),
      ).toBeNull();
    });

    // Wave 1 第二轮 Review M-5 修订：clearByOriginalPath 改用 prefix 解封语义。
    // 用户说"我授权了 /V/Disk" → POSIX 子树继承 → 该目录下所有失败条目都应解封，
    // 而不是让 LLM 逐个为 /V/Disk/sub 等子路径调一次。
    it('父路径授权时一次性解封整个子树（POSIX subtree semantics）', async () => {
      const bl = new OSErrorBlacklist();
      bl.blockToolCall('read_file', { path: '/V/Disk' }, 'OS_PERMISSION_DENIED', 'm', undefined, '/V/Disk');
      bl.blockToolCall('list_directory', { path: '/V/Disk' }, 'OS_PERMISSION_DENIED', 'm', undefined, '/V/Disk');
      bl.blockToolCall('mkdir', { path: '/V/Disk/sub' }, 'OS_PERMISSION_DENIED', 'm', undefined, '/V/Disk/sub');
      bl.blockToolCall('read_file', { path: '/V/Disk/photos/x.jpg' }, 'OS_PERMISSION_DENIED', 'm', undefined, '/V/Disk/photos/x.jpg');
      // 同时存放一条不该被命中的（仅字符串前缀，无路径分隔符边界）—— /V/DiskX
      bl.blockToolCall('read_file', { path: '/V/DiskX' }, 'OS_PERMISSION_DENIED', 'm', undefined, '/V/DiskX');

      const [, tool] = createSystemTools({ osErrorBlacklist: bl });
      const r = await tool.execute({ path: '/V/Disk', reason: '已授权' }, ctx);
      // 命中 4 条（/V/Disk + /V/Disk/sub + /V/Disk/photos/x.jpg + 重复 read_file），
      // 不命中 /V/DiskX（没有路径分隔符边界）
      expect(parseResult(r).cleared_entries).toBe(4);
      // 验证 /V/DiskX 仍在
      expect(bl.isToolCallBlocked('read_file', { path: '/V/DiskX' })).not.toBeNull();
    });

    it('精确路径不被字符串前缀误命中', async () => {
      const bl = new OSErrorBlacklist();
      bl.blockToolCall('read_file', { path: '/Users/foo/Desk' }, 'OS_PERMISSION_DENIED', 'm', undefined, '/Users/foo/Desk');
      bl.blockToolCall('read_file', { path: '/Users/foo/Desktop/x.txt' }, 'OS_PERMISSION_DENIED', 'm', undefined, '/Users/foo/Desktop/x.txt');

      const [, tool] = createSystemTools({ osErrorBlacklist: bl });
      // 用户授权 Desktop（不同路径）—— /Users/foo/Desk 不能被误清
      const r = await tool.execute({ path: '/Users/foo/Desktop', reason: '已授权' }, ctx);
      expect(parseResult(r).cleared_entries).toBe(1); // 仅 /Users/foo/Desktop/x.txt
      expect(bl.isToolCallBlocked('read_file', { path: '/Users/foo/Desk' })).not.toBeNull();
    });

    // Wave 1 第三轮 三视角 Review 共识必修：用户授权后 LLM 转述用 `~/Desktop`
    // 调 clear，但黑名单里 originalPath 是 safe-fs 展开过的绝对路径
    // `/Users/<real>/Desktop`。修前 clearByOriginalPath 字符串前缀匹配 0 命中
    // → 工具反馈"这条路径其实没有进封锁记录"→ 用户耳里像 Agent 不承认刚才报错。
    // 修后 system.clear 工具内部规范化 ~ → home 后再传给 blacklist。
    describe('Wave 1 第三轮：clear 工具内部规范化 ~/相对路径（用户语义对齐）', () => {
      it('LLM 传 ~/Desktop → 命中 originalPath /Users/<home>/Desktop', async () => {
        const os = await import('node:os');
        const path = await import('node:path');
        const realDesktop = path.join(os.homedir(), 'Desktop');

        const bl = new OSErrorBlacklist();
        // 模拟 tool-orchestration 写入的真实绝对路径（safe-fs 已展开）
        bl.blockToolCall(
          'list_directory',
          { path: realDesktop },
          'OS_PERMISSION_DENIED',
          'cached',
          undefined,
          realDesktop,
        );

        const [, tool] = createSystemTools({ osErrorBlacklist: bl });
        // LLM 转述用户「我授权了 Desktop」的常见传值（~ 起手）
        const r = await tool.execute(
          { path: '~/Desktop', reason: '用户授权了' },
          ctx,
        );
        expect(r.isError).toBeFalsy();
        const parsed = parseResult(r);
        // 关键：~/Desktop 被规范化成绝对路径后命中
        expect(parsed.cleared_entries).toBe(1);
        expect(bl.isToolCallBlocked('list_directory', { path: realDesktop })).toBeNull();
      });

      it('LLM 传 ~/Desktop/photos/x.jpg → 子树前缀匹配父条目的子路径', async () => {
        const os = await import('node:os');
        const path = await import('node:path');
        const realChild = path.join(os.homedir(), 'Desktop', 'photos', 'x.jpg');

        const bl = new OSErrorBlacklist();
        bl.blockToolCall(
          'read_file',
          { path: realChild },
          'OS_PERMISSION_DENIED',
          'cached',
          undefined,
          realChild,
        );

        const [, tool] = createSystemTools({ osErrorBlacklist: bl });
        // 用户精确授权了文件 → ~ 展开后命中
        const r = await tool.execute(
          { path: '~/Desktop/photos/x.jpg', reason: 'r' },
          ctx,
        );
        expect(parseResult(r).cleared_entries).toBe(1);
      });

      it('LLM 传含 .. 的路径 → path.normalize 归一后再匹配', async () => {
        const bl = new OSErrorBlacklist();
        bl.blockToolCall(
          'read_file',
          { path: '/tmp/foo' },
          'OS_PERMISSION_DENIED',
          'cached',
          undefined,
          '/tmp/foo',
        );

        const [, tool] = createSystemTools({ osErrorBlacklist: bl });
        // /tmp/x/../foo 经 path.normalize 后等价 /tmp/foo
        const r = await tool.execute({ path: '/tmp/x/../foo', reason: 'r' }, ctx);
        expect(parseResult(r).cleared_entries).toBe(1);
      });

      it('cleared 反馈用户消息**仍用原 path**（保留用户口语，不暴露规范化细节）', async () => {
        const os = await import('node:os');
        const path = await import('node:path');
        const realDesktop = path.join(os.homedir(), 'Desktop');

        const bl = new OSErrorBlacklist();
        bl.blockToolCall(
          'list_directory',
          { path: realDesktop },
          'OS_PERMISSION_DENIED',
          'cached',
          undefined,
          realDesktop,
        );

        const [, tool] = createSystemTools({ osErrorBlacklist: bl });
        const r = await tool.execute({ path: '~/Desktop', reason: '已授权' }, ctx);
        const parsed = parseResult(r);
        // user_message 用原 path 让 LLM 念给用户更自然
        expect(parsed.user_message).toContain('~/Desktop');
        // technical_note 也保留原 path 便于日志关联
        expect(parsed.technical_note).toContain('~/Desktop');
      });
    });
  });
});

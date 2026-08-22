/**
 * 退出时序护栏 + 探针单测（终端假运行根治 / 定位"退出滞后"潜伏 bug）。
 *
 * **背景**：detached 后台命令子进程**实际早已退出**，但 bridge 过了约 60s 才观测到
 * 退出 → 前台 poll 跑满 `wait_ms` 误返回 `status:"running"`。机制尚未坐实，需分清
 * 是「`exit`/`close` 事件本身晚到」还是「事件到了但 `finish`/flush 卡了约 60s」。
 *
 * 本文件提供两类自包含验证（不连任何 live stack / 单例运行时）：
 *
 *   1. **护栏**（`resolves promptly ...`）：构造「子进程瞬间退出、但留一个后台孙进程
 *      持有 stdout pipe 几十秒」的确定性场景——这正是「真实退出早 / 观测可能滞后」
 *      的最小复刻。runner 以 `child.once('exit')`（准时）为准、**不**死等 stdio
 *      `close`（被孙进程占住），故 `result` 应在子进程真实退出后的合理时限内 resolve。
 *      若有人把判定误改成 `close`、或 flush 卡死，本护栏立刻失败（observed ≈ 孙进程
 *      存活时长，远超阈值）。
 *
 *   2. **探针 smoke**（`exit timing probe ...`）：开 `TABTIN_DEBUG_EXIT_TIMING` 后，
 *      关键时刻（spawn / child.exit / sidecar.observed / flush / result.resolve）都落
 *      带时间戳的行；关闭时零 IO（不建文件）。保证真机复现时拿得到可对照的数据。
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnAgentShellProcess } from '../src';

const TIMING_ENV = 'TABTIN_DEBUG_EXIT_TIMING';
const TIMING_FILE_ENV = 'TABTIN_DEBUG_EXIT_TIMING_FILE';

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

describe.skipIf(process.platform === 'win32')('spawnAgentShellProcess exit timing', () => {
  afterEach(() => {
    delete process.env[TIMING_ENV];
    delete process.env[TIMING_FILE_ENV];
  });

  it('护栏：子进程真实退出后 result 及时 resolve，不被持有 stdio 的孙进程拖住', async () => {
    // 命令瞬间结束（echo + exit 0），但 `( sleep 30 & )` 双 fork 出的孙进程继承了
    // stdout pipe 写端、会把它占住约 30s。`exit` 事件准时（≈ 几十 ms），`close` 事件
    // 要等到 +30s 孙进程退出才触发——runner 必须按 `exit` 判定。
    const HELD_OPEN_SECONDS = 30;
    const RESOLVE_BUDGET_MS = 5_000; // 远小于 30s：足够吸收 CI 抖动，又能抓住"误等 close / flush 卡死"

    const startedAt = Date.now();
    const handle = spawnAgentShellProcess({
      command: `echo ready; ( sleep ${HELD_OPEN_SECONDS} & ) ; exit 0`,
      detached: true,
    });
    try {
      const result = await handle.result;
      const observedResolveMs = Date.now() - startedAt;

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.killed).toBe(false);
      expect(result.output).toContain('ready');

      // 核心护栏：真实退出 → resolve 的 wall-clock 必须远小于孙进程存活时长。
      expect(observedResolveMs).toBeLessThan(RESOLVE_BUDGET_MS);
      // runner 在 exit handler 里算 durationMs（flush 前），同样应准时。
      expect(result.durationMs).toBeLessThan(RESOLVE_BUDGET_MS);

      if (result.outputFilePath) {
        try {
          fs.unlinkSync(result.outputFilePath);
        } catch {
          /* best-effort */
        }
      }
    } finally {
      // best-effort 清掉仍在跑的孙进程（detached → 与 shell 同进程组），即使断言
      // 提前抛出也要执行，避免给 CI 留游离 sleep。
      if (handle.pid) {
        try {
          process.kill(-handle.pid, 'SIGKILL');
        } catch {
          // 已退出 / 组不存在：无所谓，孙进程也会自己 sleep 完退出
        }
      }
    }
  });

  it('exit timing probe：开 flag 后落带时间戳的关键时刻行（含 sidecar 对照 + verdict）', async () => {
    const prevFlag = process.env[TIMING_ENV];
    const prevFile = process.env[TIMING_FILE_ENV];
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-exit-timing-'));
    const logFile = path.join(workDir, 'timing.log');
    // **自包含**：sidecar 落在本测试自己 mkdtemp 的目录里（不依赖 {tmpdir}/tabtin-agent-tasks
    // 是否已存在——干净 CI 上该目录可能不存在，shell 的 `echo > statusfile` 会静默失败
    // 导致只打 sidecar.missing）。探针 smoke 只需「sidecar 能写出 + stat 得到」。
    const statusFilePath = path.join(workDir, 'sess.status');

    process.env[TIMING_ENV] = '1';
    process.env[TIMING_FILE_ENV] = logFile;
    try {
      const handle = spawnAgentShellProcess({
        command: `printf 'hello\\n'`,
        detached: true,
        statusFilePath,
      });
      const result = await handle.result;
      expect(result.exitCode).toBe(0);

      const lines = fs.readFileSync(logFile, 'utf8');
      // 关键时刻都打到了（供真机对照 exit-late vs flush-late）。
      expect(lines).toContain('spawn');
      expect(lines).toContain('child.exit');
      expect(lines).toContain('sidecar.observed');
      expect(lines).toContain('result.resolve');
      // 一行式判读（非技术用户直接看这行）。
      expect(lines).toContain('result.verdict');
      expect(lines).toContain('"verdict"');
      // 每行带相对 spawn 的毫秒差 + corr，可解析对照。
      expect(lines).toMatch(/\[TABTIN_EXIT_TIMING\] corr=\S+ pid=\S+ t\+\d+ms /);

      if (result.outputFilePath) {
        try {
          fs.unlinkSync(result.outputFilePath);
        } catch {
          /* best-effort */
        }
      }
    } finally {
      restoreEnv(TIMING_ENV, prevFlag);
      restoreEnv(TIMING_FILE_ENV, prevFile);
    }
  });

  it('exit timing probe：关 flag 时零 IO（不建落盘文件、不影响结果）', async () => {
    const prevFlag = process.env[TIMING_ENV];
    const prevFile = process.env[TIMING_FILE_ENV];
    const logFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-exit-timing-off-')),
      'should-not-exist.log',
    );

    delete process.env[TIMING_ENV]; // flag 关
    process.env[TIMING_FILE_ENV] = logFile; // 即便指定了文件，关 flag 也不该写
    try {
      const handle = spawnAgentShellProcess({
        command: `printf 'noop\\n'`,
        detached: true,
      });
      const result = await handle.result;
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(logFile)).toBe(false);

      if (result.outputFilePath) {
        try {
          fs.unlinkSync(result.outputFilePath);
        } catch {
          /* best-effort */
        }
      }
    } finally {
      restoreEnv(TIMING_ENV, prevFlag);
      restoreEnv(TIMING_FILE_ENV, prevFile);
    }
  });
});

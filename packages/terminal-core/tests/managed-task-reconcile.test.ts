/**
 * Layer 2 启动对账纯核心单测（终端假运行根治 v3 / 治 F9）。
 *
 * 全部用 fake deps（注入 fake pid 探针 / sidecar 读 / clock / sleep），不碰真实
 * fs / process。覆盖 PRD §5 Layer 2 判定矩阵：
 *   - sidecar 在 → 采信退出码（completed / failed by 126|127）；
 *   - pid 没了 + 无 sidecar → 诚实 unknown；
 *   - pid 没了 + race 后 sidecar 出现 → 采信；
 *   - pid 活着无 sidecar → 轮询，探到结束读 sidecar 回写；
 *   - pid 活着但 output_file 已不在 → pid 重用防护 → unknown；
 *   - sidecar 在但 pid 仍"活着"（重用 pid）→ 采信 sidecar、绝不轮询；
 *   - 轮询超预算 → unknown；
 *   - relay + cleanup 都被调；relay 抛错不阻断 cleanup。
 */

import { describe, expect, it } from 'vitest';
import {
  reconcileManagedTask,
  reconcileManagedTasks,
  type ManagedTaskReconcileDeps,
  type ManagedTaskReconcileRecord,
  type ReconcileTerminalState,
} from '../src/managed-task-reconcile.js';

function baseRecord(over?: Partial<ManagedTaskReconcileRecord>): ManagedTaskReconcileRecord {
  return {
    session_id: 'agent-sess-1',
    pid: 4242,
    toolUseId: 'tool-1',
    threadId: 'thread-1',
    command: 'pnpm dev',
    cwd: '/work',
    output_file_path: '/tmp/tasks/agent-sess-1.log',
    statusfile_path: '/tmp/tasks/agent-sess-1.status',
    owner: { userId: 'u1', organizationId: 'wt1' },
    started_at: 1_700_000_000_000,
    ...over,
  };
}

interface Harness {
  deps: ManagedTaskReconcileDeps;
  relayed: ReconcileTerminalState[];
  cleaned: string[];
  setPidAliveSeq: (seq: boolean[]) => void;
  setSidecarSeq: (seq: (number | null)[]) => void;
  advance: (ms: number) => void;
}

function makeHarness(opts?: {
  pidAlive?: boolean | boolean[];
  sidecar?: (number | null) | (number | null)[];
  outputFileExists?: boolean;
  relayImpl?: () => void;
  now?: number;
}): Harness {
  let clock = opts?.now ?? 1_700_000_000_000;
  const relayed: ReconcileTerminalState[] = [];
  const cleaned: string[] = [];

  let pidAliveSeq: boolean[] = Array.isArray(opts?.pidAlive)
    ? [...(opts!.pidAlive as boolean[])]
    : [opts?.pidAlive ?? true];
  let sidecarSeq: (number | null)[] = Array.isArray(opts?.sidecar)
    ? [...(opts!.sidecar as (number | null)[])]
    : [opts?.sidecar ?? null];

  const nextFrom = <T>(seq: T[]): T => (seq.length > 1 ? seq.shift()! : seq[0]!);

  const deps: ManagedTaskReconcileDeps = {
    isPidAlive: () => nextFrom(pidAliveSeq),
    readSidecarExitCode: () => nextFrom(sidecarSeq),
    outputFileExists: () => opts?.outputFileExists ?? true,
    relayTerminalState: (_record, terminal) => {
      relayed.push(terminal);
      opts?.relayImpl?.();
    },
    finalizeCleanup: (record) => {
      cleaned.push(record.session_id);
    },
    log: { info: () => {}, warn: () => {} },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    pollIntervalMs: 1_000,
  };

  return {
    deps,
    relayed,
    cleaned,
    setPidAliveSeq: (seq) => { pidAliveSeq = [...seq]; },
    setSidecarSeq: (seq) => { sidecarSeq = [...seq]; },
    advance: (ms) => { clock += ms; },
  };
}

describe('reconcileManagedTask 判定矩阵', () => {
  it('sidecar 在 + 退出码 0 → completed / normal_exit / exit_code 0', async () => {
    const h = makeHarness({ pidAlive: false, sidecar: 0 });
    const outcome = await reconcileManagedTask(baseRecord(), h.deps);
    expect(outcome).toBe('relayed_exit');
    expect(h.relayed).toHaveLength(1);
    expect(h.relayed[0]).toMatchObject({ exit_code: 0, exited_by: 'normal_exit', status: 'completed', unknown: false });
    expect(h.cleaned).toEqual(['agent-sess-1']);
  });

  it('sidecar 在 + 非 0 → completed / 非 0 退出码（业务失败由 exit_code 体现）', async () => {
    const h = makeHarness({ pidAlive: false, sidecar: 1 });
    await reconcileManagedTask(baseRecord(), h.deps);
    expect(h.relayed[0]).toMatchObject({ exit_code: 1, exited_by: 'normal_exit', status: 'completed' });
  });

  it('sidecar 127（command not found）→ failed / exec_failure', async () => {
    const h = makeHarness({ pidAlive: false, sidecar: 127 });
    await reconcileManagedTask(baseRecord(), h.deps);
    expect(h.relayed[0]).toMatchObject({ exit_code: 127, exited_by: 'exec_failure', status: 'failed' });
  });

  it('sidecar 126（not executable）→ failed / exec_failure', async () => {
    const h = makeHarness({ pidAlive: false, sidecar: 126 });
    await reconcileManagedTask(baseRecord(), h.deps);
    expect(h.relayed[0]).toMatchObject({ status: 'failed', exited_by: 'exec_failure' });
  });

  it('sidecar 137（128+SIGKILL）→ killed / signal（与 live 路径口径一致，不冒充完成）', async () => {
    const h = makeHarness({ pidAlive: false, sidecar: 137 });
    await reconcileManagedTask(baseRecord(), h.deps);
    expect(h.relayed[0]).toMatchObject({ exit_code: 137, exited_by: 'signal', status: 'killed', unknown: false });
  });

  it('sidecar 255（普通错误码，非信号区间）→ completed（不误判成被杀）', async () => {
    const h = makeHarness({ pidAlive: false, sidecar: 255 });
    await reconcileManagedTask(baseRecord(), h.deps);
    expect(h.relayed[0]).toMatchObject({ exit_code: 255, exited_by: 'normal_exit', status: 'completed' });
  });

  it('pid 没了 + 无 sidecar → 诚实 unknown（exit_code:null / status:unknown / 中性 normal_exit）', async () => {
    const h = makeHarness({ pidAlive: false, sidecar: null });
    const outcome = await reconcileManagedTask(baseRecord(), h.deps);
    expect(outcome).toBe('relayed_unknown');
    // status:'unknown' → 前端中性灰；exited_by:'normal_exit' 避免前端 signal 短路成红色「已终止」
    expect(h.relayed[0]).toMatchObject({ exit_code: null, exited_by: 'normal_exit', status: 'unknown', unknown: true });
    expect(h.cleaned).toEqual(['agent-sess-1']);
  });

  it('pid 活着但 sidecar 已在（重用 pid）→ 采信 sidecar、不轮询', async () => {
    // pidAlive 恒 true；若误进轮询会无限循环 → 测试超时即失败。
    const h = makeHarness({ pidAlive: true, sidecar: 42, outputFileExists: true });
    const outcome = await reconcileManagedTask(baseRecord(), h.deps);
    expect(outcome).toBe('relayed_exit');
    expect(h.relayed[0]).toMatchObject({ exit_code: 42 });
  });

  it('pid 活着 + 无 sidecar + output_file 不在 → pid 重用防护 → unknown', async () => {
    const h = makeHarness({ pidAlive: true, sidecar: null, outputFileExists: false });
    const outcome = await reconcileManagedTask(baseRecord(), h.deps);
    expect(outcome).toBe('relayed_unknown');
    expect(h.relayed[0]).toMatchObject({ unknown: true });
  });

  it('pid 活着 → 轮询 → 探到结束读 sidecar 回写真实退出码', async () => {
    // 第 1 轮：sidecar null + pid alive + output_file 在 → sleep；
    // 第 2 轮：sidecar null + pid 没了 → race 复读 sidecar 出 5 → completed。
    const h = makeHarness({
      pidAlive: [true, false],
      sidecar: [null, null, 5], // 轮1读null, 轮2读null(pid没了前), race复读5
      outputFileExists: true,
    });
    const outcome = await reconcileManagedTask(baseRecord(), h.deps);
    expect(outcome).toBe('relayed_exit');
    expect(h.relayed[0]).toMatchObject({ exit_code: 5, status: 'completed' });
  });

  it('轮询超预算 → 放弃 unknown（不杀孤儿）', async () => {
    // pid 恒 alive、sidecar 恒 null、output_file 在 → 每轮 sleep 推进 clock；
    // pollTimeoutMs 设小（hard_timeout_ms）→ 数轮后超预算 → unknown。
    const h = makeHarness({ pidAlive: true, sidecar: null, outputFileExists: true });
    const outcome = await reconcileManagedTask(
      baseRecord({ hard_timeout_ms: 3_000 }),
      h.deps,
    );
    expect(outcome).toBe('relayed_unknown');
    expect(h.relayed[0]).toMatchObject({ unknown: true });
  });

  it('无 pid（崩在 createRecord 与 setPid 之间）+ 无 sidecar → unknown', async () => {
    const h = makeHarness({ pidAlive: false, sidecar: null });
    const outcome = await reconcileManagedTask(baseRecord({ pid: undefined }), h.deps);
    expect(outcome).toBe('relayed_unknown');
  });

  it('relay + cleanup 都被调；relay 抛错不阻断 cleanup', async () => {
    const h = makeHarness({
      pidAlive: false,
      sidecar: 0,
      relayImpl: () => { throw new Error('relay boom'); },
    });
    const outcome = await reconcileManagedTask(baseRecord(), h.deps);
    // relay 抛错被吞，cleanup 仍跑，outcome 仍按终态分类
    expect(outcome).toBe('relayed_exit');
    expect(h.cleaned).toEqual(['agent-sess-1']);
  });

  it('duration_ms = max(0, now - started_at)（展示上界）', async () => {
    const h = makeHarness({ pidAlive: false, sidecar: 0, now: 1_700_000_005_000 });
    await reconcileManagedTask(baseRecord({ started_at: 1_700_000_000_000 }), h.deps);
    expect(h.relayed[0]!.duration_ms).toBe(5_000);
  });
});

describe('reconcileManagedTasks 批量', () => {
  it('多条并发对账，返回各自 outcome（顺序对齐）', async () => {
    const h = makeHarness({ pidAlive: false, sidecar: 0 });
    const recs = [
      baseRecord({ session_id: 's1' }),
      baseRecord({ session_id: 's2' }),
    ];
    const outcomes = await reconcileManagedTasks(recs, h.deps);
    expect(outcomes).toEqual(['relayed_exit', 'relayed_exit']);
    expect(h.cleaned.sort()).toEqual(['s1', 's2']);
  });

  it('单条 reconcile 内部异常（finalizeCleanup throw 之外）不拖垮其他条', async () => {
    // finalizeCleanup 在核心内已被 try/catch 包住；这里验证一条 record relay 抛错
    // 不影响另一条正常回写。
    let call = 0;
    const deps: ManagedTaskReconcileDeps = {
      isPidAlive: () => false,
      readSidecarExitCode: () => 0,
      outputFileExists: () => true,
      relayTerminalState: () => { call += 1; if (call === 1) throw new Error('boom'); },
      finalizeCleanup: () => {},
      log: { warn: () => {} },
      now: () => 1,
      sleep: async () => {},
    };
    const outcomes = await reconcileManagedTasks(
      [baseRecord({ session_id: 'a' }), baseRecord({ session_id: 'b' })],
      deps,
    );
    expect(outcomes).toEqual(['relayed_exit', 'relayed_exit']);
  });
});

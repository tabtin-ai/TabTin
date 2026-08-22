/**
 * Daemon-side ``getRecentRunObservations`` 实现 —— W7c · Stage 4 Daemon 路径对齐。
 *
 * 用途：与 ``apps/tabtin-electron/src/main/agent/conversation/run-observation-injector.ts`` 同名职责，
 * 但承担**显式降级语义**：Daemon 进程没有 Electron 端 ``RunSessionManager`` /
 * autofill / Space env 切换等 host-side observation 写入路径，所以 injector 始终
 * 返回空数组——这是已知边界，不是 bug。
 *
 * 为什么不直接 inline `async () => []`：
 *   1. 让 P5 audit 能识别"Daemon 选择了 NoOp injector"作为显式登记的差异，
 *      区分"漏接"和"主动降级"——避免未来 reviewer 误以为忘了；
 *   2. 提供 ``reason`` / ``isNoop`` 元信息供测试断言："Daemon 这条路径上必须是
 *      NoOp injector，否则等于偷偷往生产塞了一个有副作用的 observation 源"；
 *   3. 给未来 Daemon 接入远端 host observation（譬如手机端 autofill 通过 Django
 *      推回 Daemon）留接入点 —— 替换本工厂的实现即可，调用站不动。
 *
 * 治理 07 §F.5 / 99 §阶段 4 留给后续：
 *   当 Daemon 端真正接入 RunSession observation 源（譬如远端客户端 autofill 失败
 *   通过 WS 推回 Daemon）时，把 ``createDaemonRunObservationInjector`` 改成读取
 *   真实队列即可；P5 audit 的"NoOp"豁免也应同时摘除。
 */

import type { RunObservationInjection } from '@tabtin/agent-runtime/engine';

export interface DaemonRunObservationInjectorHandle {
  /** ``EngineConfig.getRecentRunObservations`` 实际入参 —— 当前恒返回 ``[]``。 */
  injector: () => Promise<RunObservationInjection[]>;
  /**
   * 是否是降级 NoOp 实现（true = Daemon 路径当前无 host-side observation 源）。
   * 用于 P5 audit 显式登记差异；生产代码不消费。
   */
  readonly isNoop: boolean;
  /**
   * 降级原因（人类可读，用于 audit error 信息 / 文档生成）。
   * 生产代码不消费。
   */
  readonly reason: string;
}

/** Daemon 当前 host-side observation 源缺失的官方降级理由 —— P5 audit / 文档共用 SSoT。 */
export const DAEMON_RUN_OBSERVATION_NOOP_REASON =
  'Daemon 当前没有 host-side observation 写入路径（autofill / RunSessionManager 在 ' +
  'Electron 主进程，Daemon 是 headless）—— 接入远端 autofill 推送后摘除本降级';

/**
 * 构造 Daemon 端 ``getRecentRunObservations`` 实现。
 *
 * 当前是 NoOp（恒返回 ``[]``） —— 与治理 07 §F.5 描述的现状一致。未来接入 Daemon-side
 * observation 源时替换此工厂的 injector 实现即可，``createRuntimeForSession`` 不动。
 */
export function createDaemonRunObservationInjector(): DaemonRunObservationInjectorHandle {
  const injector = async (): Promise<RunObservationInjection[]> => [];
  return {
    injector,
    isNoop: true,
    reason: DAEMON_RUN_OBSERVATION_NOOP_REASON,
  };
}

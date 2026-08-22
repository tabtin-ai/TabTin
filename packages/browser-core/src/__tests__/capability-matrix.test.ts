import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  BROWSER_CAPABILITY_MATRIX,
  CAPABILITY_MATRIX_VERSION,
  projectCapabilitiesForRuntime,
  getBrowserActionIds,
  getBrowserCapability,
  type BrowserRuntime,
  type SupportLevel,
} from '../capability-matrix';

// 期望覆盖的 action 集合 —— BR-7 check④「跨语言锚点」的 TS 侧。
//
// 不再硬编码：从 CLI 导出的契约投影 JSON 读取（browser-cli-contract.json，由
// `scripts/generate-browser-contract.py` 跑 Go 导出生成，权威源是 browser.go 的命令树）。
// 这样矩阵直接对齐**真实 CLI 命令全集**，而非一份要人肉同步的镜像清单。
//   - Go 侧（cmd/browser/browser_contract_test.go）守 CLI 命令树 == 落盘 JSON（漂移即红）。
//   - 这里守 矩阵 == JSON 里的「非自描述」命令集（漂移即红）。
//   - Go 不 import TS、TS 只读 Go 产出的 JSON —— 跨语言锚点闭环。
//
// 自描述命令（context / capabilities，BR-5/6）是真实 CLI 命令但不属于 action 矩阵，按
// JSON 里的 selfDescribe 标记剔除。
interface ContractCommand {
  id: string;
  selfDescribe?: boolean;
  diagnostic?: boolean;
}
const CONTRACT = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../generated/browser-cli-contract.json', import.meta.url)),
    'utf-8',
  ),
) as { commands: ContractCommand[] };

const EXPECTED_ACTION_IDS = CONTRACT.commands
  .filter((c) => !c.selfDescribe && !c.diagnostic)
  .map((c) => c.id);

const RUNTIMES: BrowserRuntime[] = ['electron', 'daemon'];
const LEVELS: SupportLevel[] = ['full', 'degraded', 'unsupported'];

describe('capability-matrix 种子校验', () => {
  it('契约 JSON 正常加载（防 JSON 缺失/损坏导致后续断言空过）', () => {
    expect(EXPECTED_ACTION_IDS.length).toBeGreaterThan(40);
  });

  it('矩阵必须覆盖所有已注册 browser action（不多不少、一一对应）', () => {
    const actual = getBrowserActionIds().slice().sort();
    const expected = [...EXPECTED_ACTION_IDS].sort();
    expect(actual).toEqual(expected);
    expect(BROWSER_CAPABILITY_MATRIX.length).toBe(EXPECTED_ACTION_IDS.length);
  });

  it('action id 唯一、不重复', () => {
    const ids = getBrowserActionIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('action id 命名合法（顶层命令名 或 group.sub）', () => {
    const pattern = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/;
    for (const id of getBrowserActionIds()) {
      expect(id, `非法 action id: ${id}`).toMatch(pattern);
    }
  });

  it('每个 action 两端都有合法支持级别', () => {
    for (const cap of BROWSER_CAPABILITY_MATRIX) {
      for (const runtime of RUNTIMES) {
        const support = cap.runtimes[runtime];
        expect(support, `${cap.id} 缺 ${runtime} 列`).toBeDefined();
        expect(LEVELS, `${cap.id}.${runtime} 级别非法: ${support.level}`).toContain(support.level);
      }
    }
  });

  it('每个 action 都有非空 summary', () => {
    for (const cap of BROWSER_CAPABILITY_MATRIX) {
      expect(cap.summary.trim().length, `${cap.id} 缺 summary`).toBeGreaterThan(0);
    }
  });

  it('degraded / unsupported 必须带 note（降级/不支持原因），full 不带', () => {
    for (const cap of BROWSER_CAPABILITY_MATRIX) {
      for (const runtime of RUNTIMES) {
        const support = cap.runtimes[runtime];
        if (support.level === 'full') {
          expect(support.note, `${cap.id}.${runtime} full 不该带 note`).toBeUndefined();
        } else {
          expect(
            (support.note ?? '').trim().length,
            `${cap.id}.${runtime} 标 ${support.level} 却没写原因`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it('标 unsupported 的 action 不该两端都 unsupported（既有可达 CLI 命令，至少一端要能用）', () => {
    // 含义：每个 action 都有一条可达的 CLI 命令；若两端都 unsupported，
    // 说明这条命令对 Agent 永远是死路，根本不该注册——视为矩阵/CLI 不一致。
    for (const cap of BROWSER_CAPABILITY_MATRIX) {
      const allUnsupported = RUNTIMES.every((r) => cap.runtimes[r].level === 'unsupported');
      expect(allUnsupported, `${cap.id} 两端都 unsupported，却有可达 CLI 命令`).toBe(false);
    }
  });

  it('Electron 作为 GUI 全量运行时，所有 action 均为 full', () => {
    // 当前 main 现状：48 个 action 在 Electron 端全部有真实 handler。
    // 若将来 Electron 某 action 降级，这条会红，提醒同步矩阵。
    for (const cap of BROWSER_CAPABILITY_MATRIX) {
      expect(cap.runtimes.electron.level, `${cap.id} Electron 非 full`).toBe('full');
    }
  });
});

describe('projectCapabilitiesForRuntime', () => {
  it('只投影「我这一端」那一列，且与矩阵同源（永不漂移）', () => {
    for (const runtime of RUNTIMES) {
      const projection = projectCapabilitiesForRuntime(runtime);
      expect(projection.runtime).toBe(runtime);
      expect(projection.schemaVersion).toBe(CAPABILITY_MATRIX_VERSION);
      expect(projection.actions.length).toBe(BROWSER_CAPABILITY_MATRIX.length);

      for (const entry of projection.actions) {
        const cap = getBrowserCapability(entry.id)!;
        const source = cap.runtimes[runtime];
        expect(entry.level).toBe(source.level);
        expect(entry.note).toBe(source.note);
        expect(entry.summary).toBe(cap.summary);
      }
    }
  });

  it('counts 与各级别实际数量一致、加总 = action 总数', () => {
    for (const runtime of RUNTIMES) {
      const projection = projectCapabilitiesForRuntime(runtime);
      const recount: Record<SupportLevel, number> = { full: 0, degraded: 0, unsupported: 0 };
      for (const entry of projection.actions) recount[entry.level] += 1;
      expect(projection.counts).toEqual(recount);
      const total = LEVELS.reduce((sum, l) => sum + projection.counts[l], 0);
      expect(total).toBe(BROWSER_CAPABILITY_MATRIX.length);
    }
  });

  it('Daemon 投影如实反映已知降级 / 不支持项（防被静默改回 full）', () => {
    const daemon = projectCapabilitiesForRuntime('daemon');
    const byId = new Map(daemon.actions.map((a) => [a.id, a]));

    // BW-2：Daemon session save/load 已从 BR-3 的诚实 501 升级为 storageState 主链真存取；
    // 但 IndexedDB 与 sessionStorage 页面依赖仍使其不是 full。
    expect(byId.get('session.save')!.level).toBe('degraded');
    expect(byId.get('session.load')!.level).toBe('degraded');

    // 文档（BR-4）明确的 Daemon 降级项（snapshot 已收编进 glance --tree）
    expect(byId.get('glance')!.level).toBe('degraded');
    expect(byId.get('tab.state')!.level).toBe('degraded');
    expect(byId.get('resource.smart-download')!.level).toBe('degraded');

    // BR-8 P2后 daemon network/console 返回历史日志、双端 live 实测同形 → 上调 full
    expect(byId.get('network')!.level).toBe('full');
    expect(byId.get('console')!.level).toBe('full');

    // BR-2 拦截：route/unroute 为 per-page 降级；route-list 规则不可枚举 → unsupported
    expect(byId.get('route')!.level).toBe('degraded');
    expect(byId.get('unroute')!.level).toBe('degraded');
    expect(byId.get('route-list')!.level).toBe('unsupported');

    // BR-1 已合 main：cookies.set 在 Daemon 现为 full（收 set 作 add 别名）
    expect(byId.get('cookies.set')!.level).toBe('full');
  });
});

describe('getBrowserCapability', () => {
  it('已知 id 命中、未知 id 返回 undefined', () => {
    expect(getBrowserCapability('open')?.id).toBe('open');
    expect(getBrowserCapability('does-not-exist')).toBeUndefined();
  });
});

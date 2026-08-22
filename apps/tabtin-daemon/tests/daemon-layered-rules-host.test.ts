/**
 * IA Phase 3·3B-1 Daemon host 层分层规则接线源码合同（I-1）。
 *
 * 钉死 Daemon host 侧「个人 personal_rules + Agent custom_rules」分层规则在 runtime
 * 缓存键 / 解包链路的接线，锁两个不变量：
 *
 *   1. 「改规则即重建」—— personalRules 经 host 组装 `cacheKeyInput` 传给共享
 *      `RuntimeSessionFactory.resolve`；factory 内部走
 *      `createRuntimeCacheKey` 归一（trim → undefined）+ `runtimeCacheKeysMatch`
 *      比较，`buildDaemonHostState` 通过 `...cacheKey` 展开写入 DaemonHostState；
 *      push-drain 从 session 回填。同 session 改个人规则 → 缓存键失配 →
 *      cache miss → runtime 重建；不变 → 复用。共享比较逻辑本身由 agent-host
 *      单测锁定，本文件只锁 host 与 factory 的**接线锚点**。
 *   2. wire envelope snake→camel 解包 —— daemon.ts routeToLocalAgentHost 从
 *      payload.personal_rules 解出 personalRules。
 *
 * （2026-06：原团队基线层 team_rules 已下线——团队不再对 Agent 设统一 prompt 基线，
 * 岗位差异化交给 skill 系统。分层规则降为 个人 + Agent 两层。）
 *
 * 设计：与 yolo-daemon-wire.test.ts 同模式做「源码合同扫描」—— DaemonAgentHost
 * 构造期有 mkdir / logger / gateway 等副作用，无法在 vitest 里实例化跑真实缓存命中
 * 行为，故直接读源码断言关键 token 与顺序。配合 TS 编译期类型检查构成「类型 + 源码
 * 模式」双保险。行为级断言见 packages/agent-host 的 runtime-session-cache-key-* 测试。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function readSrc(rel: string): string {
  const full = path.resolve(__dirname, '..', rel);
  return fs.readFileSync(full, 'utf-8');
}

describe('IA Phase 3·3B-1 Daemon host 分层规则源码合同（I-1）', () => {
  it('DaemonHostState 接口含 personalRules（创建期烘焙字段，参与缓存键）', () => {
    const src = readSrc('src/application/agent/daemon-agent-host.ts');
    const ifaceIdx = src.indexOf('interface DaemonHostState extends RuntimeCacheKey');
    expect(ifaceIdx, 'DaemonHostState 必须扩展 RuntimeCacheKey').toBeGreaterThan(-1);
    const block = src.slice(ifaceIdx, ifaceIdx + 3000);
    expect(
      block,
      'DaemonHostState 必须含 personalRules 字段以参与缓存键比较',
    ).toMatch(/personalRules:\s*string\s*\|\s*undefined/);
  });

  it('host 组装 cacheKeyInput 并带上 personalRules（buildDaemonRequestFromQuery）', () => {
    // 真实路径：`buildDaemonRequestFromQuery` 组装 `cacheKeyInput` 直接喂给共享
    // `RuntimeSessionFactory`（factory 内部再走 `createRuntimeCacheKey`
    // + `runtimeCacheKeysMatch`），host 侧不再手抄归一逻辑。与 Electron 对齐。
    const src = readSrc('src/application/agent/daemon-agent-host.ts');
    const fnIdx = src.indexOf('private buildDaemonRequestFromQuery(');
    expect(fnIdx, 'buildDaemonRequestFromQuery 必须存在').toBeGreaterThan(-1);
    const body = src.slice(fnIdx, fnIdx + 6000);
    expect(
      body,
      '必须组装 cacheKeyInput（factory 内部再走共享 createRuntimeCacheKey）',
    ).toContain('const cacheKeyInput = {');
    expect(
      body,
      'personalRules 必须写进 cacheKeyInput（trim / undefined 归一在 agent-host 内完成）',
    ).toMatch(/const cacheKeyInput = \{[\s\S]*?personalRules/);
  });

  it('runtime 复用 / 重建决策经 RuntimeSessionFactory（改规则即重建，装配已迁入 daemon-runtime-assembly）', () => {
    // Agent Host 归位：live runtime 装配（factory 实例化 + adapter）迁入
    // daemon-runtime-assembly.ts；host 侧只经 `runtimeAssembly.getRuntimeFactory()`
    // 把 factory 注入查询引擎，engine 内部按 `runtimeCacheKeysMatch` 决策 reuse /
    // soft-reconfigure / rebuild。
    const asm = readSrc('src/application/agent/runtime/daemon-runtime-assembly.ts');
    expect(asm, 'RuntimeSessionFactory 必须实例化').toContain('new RuntimeSessionFactory<');
    expect(asm, 'factory 必须由装配层装 adapter 并复用 ports.sessions 作 registry').toContain(
      'this.buildRuntimeFactoryAdapter(), this.ports.session.sessions',
    );
    const host = readSrc('src/application/agent/daemon-agent-host.ts');
    expect(host, 'host 侧经装配层拿 factory 注入查询引擎').toContain(
      'factory: this.runtimeAssembly.getRuntimeFactory()',
    );
  });

  it('build 分支通过 spread cacheKey 展开 personalRules 到 DaemonHostState（buildDaemonHostState 已迁入装配层）', () => {
    // factory 归一化后的 `RuntimeCacheKey` 通过 `context.cacheKey` 透给
    // `buildDaemonHostState`（已迁入 daemon-runtime-assembly），其中 `...cacheKey`
    // 展开保证看到的字段与 factory 内部 `runtimeCacheKeysMatch` 完全一致。
    const asm = readSrc('src/application/agent/runtime/daemon-runtime-assembly.ts');
    expect(
      asm,
      'buildDaemonHostState 必须展开 cacheKey（含归一后的 personalRules）',
    ).toMatch(/const state: DaemonHostState = \{[\s\S]*?\.\.\.cacheKey/);
  });

  it('push-drain 从 session 回填 personalRules（让缓存命中、零开销复用上轮 runtime）', () => {
    const src = readSrc('src/application/agent/daemon-agent-host.ts');
    expect(
      src,
      'push-drain 必须从 session 回填 personalRules',
    ).toMatch(/personalRules:\s*session\.personalRules/);
  });

  it('daemon.ts routeToLocalAgentHost 从共享 ForwardConversationRequest 拿 personalRules（snake→camel 归一由 agent-host 单测锁定）', () => {
    // 架构演进：`daemon.ts` 不再直接 safeParse wire payload，personal_rules 的
    // snake→camel 归一收口到 `@tabtin/agent-host/conversation`
    // `decodeForwardRequestDetailed`（agent-host 单测锁定 `payload.personal_rules
    // → request.personalRules` 契约）。daemon 侧只需从 request 透穿。
    const src = readSrc('src/bootstrap/daemon.ts');
    const fnIdx = src.indexOf('private async routeToLocalAgentHost(');
    expect(fnIdx, 'routeToLocalAgentHost 必须存在').toBeGreaterThan(-1);
    const body = src.slice(fnIdx, fnIdx + 4000);
    expect(
      body,
      'routeToLocalAgentHost 必须从 request.personalRules 透传 personalRules',
    ).toMatch(/personalRules:\s*request\.personalRules/);
  });

  it('防回归：分层规则全链 token 同时存在（任一环被删即 fail）', () => {
    const hostSrc = readSrc('src/application/agent/daemon-agent-host.ts');
    const asmSrc = readSrc('src/application/agent/runtime/daemon-runtime-assembly.ts');
    const daemonSrc = readSrc('src/bootstrap/daemon.ts');
    // 与 Electron `runtime-session-cache-key-wiring.test.ts` 对齐：新架构下
    // 关注 host 与装配层的**接线锚点**（host: cacheKeyInput + push-drain 回填；
    // 装配层: RuntimeSessionFactory + spread cacheKey），共享比较逻辑本身由
    // agent-host 单测锁定。
    const hostTokens = [
      /const cacheKeyInput = \{/,
      /personalRules:\s*session\.personalRules/,
    ];
    for (const t of hostTokens) {
      expect(hostSrc, `DaemonAgentHost 分层规则 token 必须存在: ${t}`).toMatch(t);
    }
    const asmTokens = [
      /new RuntimeSessionFactory</,
      /const state: DaemonHostState = \{[\s\S]*?\.\.\.cacheKey/,
    ];
    for (const t of asmTokens) {
      expect(asmSrc, `daemon-runtime-assembly 分层规则 token 必须存在: ${t}`).toMatch(t);
    }
    expect(daemonSrc, 'daemon.ts 必须从 request 透传 personalRules').toMatch(/personalRules:\s*request\.personalRules/);
  });

  it('防回归：团队基线层已下线（host / daemon 不再含 teamRules / team_rules）', () => {
    const hostSrc = readSrc('src/application/agent/daemon-agent-host.ts');
    const daemonSrc = readSrc('src/bootstrap/daemon.ts');
    expect(hostSrc, 'DaemonAgentHost 不应再含 teamRules（团队基线层已下线）').not.toMatch(/teamRules/);
    expect(daemonSrc, 'daemon.ts 不应再含 team_rules（团队基线层已下线）').not.toMatch(/team_rules/);
  });

  it('compact 必须拒绝缺失或跨 Workspace 的执行场', () => {
    const src = readSrc('src/application/agent/daemon-agent-host.ts');
    const start = src.indexOf('async compactSession(');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 3500);
    expect(block).toContain("error: 'workspaceId is required'");
    expect(block).toContain('session.workspaceId !== workspaceId');
    expect(block).toContain("error: 'session belongs to another workspace'");
  });
});

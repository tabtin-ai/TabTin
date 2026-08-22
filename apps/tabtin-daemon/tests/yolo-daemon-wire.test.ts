/**
 * PR4-yolo Daemon 路径 wire 链路打通 + ContextVar 接通（fix/yolo-daemon-wire-and-contextvar）。
 *
 * 钉死本 PR 的 Daemon TS 侧 wire / H5 修复源码合同：
 *
 * Task 2：daemon.ts resolveAgentMode 白名单含 'yolo'。
 * Task 3：action-bridge.ts handleAction 把 payload.agent_mode / is_group_space
 *         注入 params._agent_mode / params._is_group_space（与 _sandbox_policy 同模式）。
 * Task 4：DaemonAgentHost.createRuntimeForSession policyContext.isGroupSpace
 *         从硬编码 false 改为 !!isGroupSpace（H5 fail-open 修复）。
 *
 * 设计：与 w7c-dispatcher-and-hitl.test.ts 同模式做"源码合同扫描"
 * （avoid 拉起整个 host 实例触发 mkdir / logger / gateway 副作用）。
 * 重构时谁回退了 wire 字段就会被这组测拦下。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function readSrc(rel: string): string {
  const full = path.resolve(__dirname, '..', rel);
  return fs.readFileSync(full, 'utf-8');
}

describe('PR4-yolo Daemon wire source contract', () => {
  it('Task 2: daemon.ts resolveAgentMode 白名单含 yolo', () => {
    const src = readSrc('src/bootstrap/daemon.ts');
    // 定位函数**定义**（``private resolveAgentMode``），不是调用位置（``this.resolveAgentMode(``）。
    const idx = src.indexOf('private resolveAgentMode(');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 2000);
    // 函数返回类型签名含 'yolo'，且白名单分支显式 raw === 'yolo'
    expect(body).toMatch(/\|\s*['"]yolo['"]/);
    expect(body).toMatch(/raw\s*===\s*['"]yolo['"]/);
  });

  it('Task 2 wire request: is_group_space 解到 DaemonQueryRequest.isGroupSpace（snake→camel 收口到 agent-host 共享 decoder）', () => {
    const src = readSrc('src/bootstrap/daemon.ts');
    // 架构演进：`daemon.ts` routeToLocalAgentHost 不再直接读原始 payload，
    // is_group_space → request.isGroupSpace 的归一由 agent-host
    // `decodeForwardRequestDetailed` 完成（agent-host 单测锁定该行为）。
    expect(src).toMatch(/isGroupSpace:\s*request\.isGroupSpace/);
  });

  it('Task 3: action-bridge.ts 注入 _agent_mode / _is_group_space (parity with _sandbox_policy)', () => {
    const src = readSrc('src/application/execution/action-bridge.ts');
    // 与现有 ``params._sandbox_policy = sandboxPolicy`` 同模式
    expect(src).toMatch(/params\._sandbox_policy\s*=\s*sandboxPolicy/);
    // 任务 3 新增
    expect(src).toMatch(/params\._agent_mode\s*=\s*payload\.agent_mode/);
    expect(src).toMatch(/params\._is_group_space\s*=\s*payload\.is_group_space/);
    // 白名单分支与 daemon.ts resolveAgentMode 一致（含 'yolo'）
    expect(src).toMatch(/allowedModes\.has\(payload\.agent_mode\)/);
  });

  it('Task 4: policyContext.isGroupSpace 不再硬编码 false (H5 修复；装配已迁入 daemon-runtime-assembly)', () => {
    // Agent Host 归位：createRuntimeForSession（写 policyContext.isGroupSpace）已迁入
    // daemon-runtime-assembly.ts，契约 grep 随之指向装配层文件。
    const src = readSrc('src/application/agent/runtime/daemon-runtime-assembly.ts');
    // 关键：旧硬编码 ``isGroupSpace: false,`` literal 已删
    // 改为 ``isGroupSpace: !!isGroupSpace``（从 wire payload 传入）
    expect(src).toMatch(/isGroupSpace:\s*!!isGroupSpace/);
    // "暂留 fail-open" 注释行也应清掉
    expect(src).not.toMatch(/暂留 false fail-open/);
    expect(src).not.toMatch(/isGroupSpace:\s*false,\s*\n\s*\}\s*;/);
  });

  it('Task 4: DaemonQueryRequest 新增 isGroupSpace?: boolean', () => {
    const src = readSrc('src/application/agent/daemon-agent-host.ts');
    // DaemonQueryRequest interface 必须含 isGroupSpace 字段（与 ElectronHostState parity）
    const ifaceStart = src.indexOf('export interface DaemonQueryRequest');
    expect(ifaceStart).toBeGreaterThan(-1);
    const ifaceEnd = src.indexOf('\n}', ifaceStart);
    const ifaceBody = src.slice(ifaceStart, ifaceEnd);
    expect(ifaceBody).toMatch(/isGroupSpace\?:\s*boolean/);
  });

  it('Task 4: isGroupSpace 透传链——host RuntimeBuildInput → 装配层 createRuntimeForSession policyContext', () => {
    // Agent Host 归位后真实链路：wire 的 isGroupSpace 由 host `buildDaemonRequestFromQuery`
    // 装进 RuntimeBuildInput（喂共享 factory），createRuntimeForSession（已迁入
    // daemon-runtime-assembly）再消费它写入 policyContext.isGroupSpace。
    const host = readSrc('src/application/agent/daemon-agent-host.ts');
    // host 侧 buildInput 把 wire isGroupSpace 带入 RuntimeBuildInput。
    expect(host).toMatch(/isGroupSpace:\s*request\.isGroupSpace/);
    // 装配层 createRuntimeForSession 存在并把 isGroupSpace 写入 policyContext。
    const asm = readSrc('src/application/agent/runtime/daemon-runtime-assembly.ts');
    expect(asm.indexOf('private async createRuntimeForSession(')).toBeGreaterThan(-1);
    expect(asm).toMatch(/isGroupSpace:\s*!!isGroupSpace/);
  });
});

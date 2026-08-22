#!/usr/bin/env node
/**
 * 从 prompts/subagent_worker.md 生成 src/subagent/generated-worker-section.ts。
 *
 * SSoT 是 .md 文件——修改 worker 段只需编辑 .md，然后 build 自动重新生成 TS 常量。
 * 与 @tabtin/agent-prompt 的 generate-content.mjs / @tabtin/agent-modes 的
 * gen-prompt-sections.mjs 同一模式（generated 产物勿手改，改了会被 prebuild 覆盖）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(__dirname, '../prompts/subagent_worker.md');
const OUTPUT = resolve(__dirname, '../src/subagent/generated-worker-section.ts');

const body = readFileSync(SOURCE, 'utf8').trim();
const escaped = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const output = `/**
 * ⚠️ 生成文件——不要手改。
 *
 * SSoT：packages/agent-runtime/prompts/subagent_worker.md
 * 生成：node scripts/generate-worker-section.mjs（prebuild 自动执行）
 *
 * W1（压缩路径简化）子 Agent 框定段：fork 注入、所有 worker
 * （含 readonly/ask）唯一必看的段落。能力引导（批量取证等）必须在这里，
 * 而不是只存在于仅主 Agent 可见的 <subagent_orchestration>。
 */

export const SUBAGENT_WORKER_SYSTEM_SECTION = \`${escaped}\`;
`;

writeFileSync(OUTPUT, output);
console.log(`✓ Generated ${OUTPUT}`);

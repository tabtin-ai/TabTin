/**
 * 总入口：跑全套 codegen 流水线。
 *
 * 步骤：
 *   00 build @tabtin/agent-wire (确保 dist/ 是最新 zod schema)
 *   01 emit JSON Schema (含 oneOf+discriminator 注入)
 *   02 emit fixtures (22 case + 7 边界 case + 6 envelope)
 *   03 gen Python   (Pydantic v2 + extra=ignore + Annotated)
 *   04 gen Swift    (type-safe enum + associated value)
 *   05 gen Kotlin   (kotlinx-serialization sealed class)
 *   06 gen TS       (re-export agent-wire)
 *   07 vendor in    (cp 各端 vendor 路径)
 *
 * 用法：pnpm --filter @tabtin/wire-codegen codegen
 *
 * 第 0 步必要性（W1 P1-A 真根因修复）：
 *   01_emit_json_schema.ts 通过 `import { ContentBlockSchema } from '@tabtin/agent-wire'`
 *   读 zod schema —— 这个 import 解析到 `packages/agent-wire/dist/`（编译后产物）。
 *   如果开发者改了 src/stream-content-block.ts 但没 build agent-wire，codegen 读到的
 *   还是旧 dist —— schema 漂移 silent bypass。所以 codegen 第一步必须 build agent-wire，
 *   保证 dist/ 与 src/ 同步。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PKG_ROOT, REPO_ROOT } from './lib/paths.js';

console.log('═══════════════════════════════════════════════════════════════');
console.log('  @tabtin/wire-codegen — full codegen pipeline');
console.log('═══════════════════════════════════════════════════════════════\n');

const startTime = Date.now();

console.log('▶ 第 0 步：build @tabtin/agent-wire（确保 dist/ 是最新 zod schema）');
const buildResult = spawnSync(
  'pnpm',
  ['--filter', '@tabtin/agent-wire', 'build'],
  {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  },
);
if (buildResult.status !== 0) {
  console.error(
    `\n✘ agent-wire build 失败 (exit ${buildResult.status})。无法继续 codegen——dist/ 是过期版本会让 schema 漂移 silent bypass。`,
  );
  process.exit(1);
}

const steps = [
  '01_emit_json_schema.ts',
  '02_emit_fixtures.ts',
  '03_gen_python.ts',
  '04_gen_swift.ts',
  '05_gen_kotlin.ts',
  '06_gen_typescript.ts',
  '07_vendor_in.ts',
];

for (const step of steps) {
  console.log(`\n▶ ${step}`);
  const scriptPath = resolve(PKG_ROOT, 'scripts', step);
  const result = spawnSync('npx', ['tsx', scriptPath], {
    stdio: 'inherit',
    cwd: PKG_ROOT,
  });
  if (result.status !== 0) {
    console.error(`\n✘ ${step} failed (exit ${result.status}). 中断后续步骤。`);
    process.exit(1);
  }
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n═══════════════════════════════════════════════════════════════`);
console.log(`  ✔ All ${steps.length + 1} steps complete (${elapsed}s)`);
console.log(`═══════════════════════════════════════════════════════════════`);

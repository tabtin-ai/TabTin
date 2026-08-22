/**
 * Step 4: 生成 Swift（type-safe enum + associated value，sealed-like）。
 *
 * **不用 quicktype default**——W0 PoC §3.3 实测 quicktype 默认输出把 22 case
 * 的 unique 字段全 optional 塞一个 super-struct，**完全失去类型安全**。
 *
 * 本脚本从 JSON Schema 直接生成 Swift 代码：
 *   - 每个 oneOf+discriminator union 生成 `enum X: Codable` + `init(from:)`/`encode(to:)`
 *   - 每个 object 生成 `struct X: Codable`
 *   - 顶层 ContentBlock 22 case 全部按 `case text(TextBlock)` / `case toolUse(ToolUseBlock)` ...
 *
 * 输出：generated/swift/*.swift
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { GENERATED_SWIFT_DIR, HANDWRITTEN_FILES_SWIFT, SCHEMAS_DIR } from './lib/paths.js';
import { generateSwiftFile } from './lib/swift_codegen.js';

// W4.5 B3 · 不再 rmSync 整目录——会静默删掉 generated/swift/ 内的手写常驻
// SSOT 占位（譬如 StreamEventIdValidator.swift）。改为只删 codegen 自己生成
// 过的非 handwritten 文件。allow-list 见 lib/paths.ts::HANDWRITTEN_FILES_SWIFT。
if (existsSync(GENERATED_SWIFT_DIR)) {
  for (const entry of readdirSync(GENERATED_SWIFT_DIR)) {
    if (HANDWRITTEN_FILES_SWIFT.has(entry)) continue;
    unlinkSync(resolve(GENERATED_SWIFT_DIR, entry));
  }
} else {
  mkdirSync(GENERATED_SWIFT_DIR, { recursive: true });
}

// any_event.json 必须最后处理：它内嵌全量 definitions，若先跑会在 AnyEvent.swift
// 重复生成 MessageStart 等 envelope struct（与独立 envelope 文件同形），Swift 合成
// Hashable 时会报 circular reference。末位处理 + union 引用 canonical 类型可解。
const schemaFiles = readdirSync(SCHEMAS_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort((a, b) => {
    if (a === 'any_event.json') return 1;
    if (b === 'any_event.json') return -1;
    // content_block.json 必须早于 content_block_* / message_* —— 否则 ContentBlock
    // 22-case union 会落到 ContentBlockDelta.swift 等 envelope 文件里。
    if (a === 'content_block.json') return -1;
    if (b === 'content_block.json') return 1;
    return a.localeCompare(b);
  });
console.log(`[04_gen_swift] 准备生成 ${schemaFiles.length} 个 Swift 文件...`);

let okCount = 0;
let failCount = 0;
const allEmittedTypes = new Set<string>();

// 第一遍：生成所有 schema 对应的 Swift 文件
// 用 emittedTypes 跨 schema 去重（避免 ContentBlock 在 envelope schemas 中重复定义）
for (const schemaFile of schemaFiles) {
  const baseName = schemaFile.replace(/\.json$/, '');
  const inputPath = resolve(SCHEMAS_DIR, schemaFile);
  const outputPath = resolve(GENERATED_SWIFT_DIR, `${pascalCase(baseName)}.swift`);

  try {
    const schema = JSON.parse(readFileSync(inputPath, 'utf-8'));
    const code = generateSwiftFile(schema, baseName, allEmittedTypes);
    writeFileSync(outputPath, code);
    console.log(`  ✔ ${pascalCase(baseName)}.swift`);
    okCount++;
  } catch (e) {
    console.error(`  ✘ ${schemaFile}: ${(e as Error).message}\n${(e as Error).stack}`);
    failCount++;
  }
}

console.log(`\n[04_gen_swift] 完成：${okCount} ok, ${failCount} fail → ${GENERATED_SWIFT_DIR}`);
if (failCount > 0) process.exit(1);

function pascalCase(snake: string): string {
  return snake
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

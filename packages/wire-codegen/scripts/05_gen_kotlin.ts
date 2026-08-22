/**
 * Step 5: 生成 Kotlin（type-safe sealed class + kotlinx-serialization）。
 *
 * **不用 quicktype default + Klaxon**——W0 PoC §3.3 实测同样失类型安全，
 * 且 Klaxon enum decoding 还要手写 fromJson companion。本脚本切换到
 * kotlinx-serialization (Android Gradle 已经依赖 1.7.3，见
 * `apps/tabtin-android/gradle/libs.versions.toml`)。
 *
 * 输出：generated/kotlin/*.kt
 *
 * 关键点：
 *   - `@Serializable @JsonClassDiscriminator("type") sealed class X`
 *   - `@SerialName("text") @Serializable data class Text(...) : X()`
 *   - `JsonObject` / `JsonElement` 用于 Map<String, Any> 字段
 *   - 不需要 fromJson companion——Json.encodeToString / decodeFromString 直接用
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { GENERATED_KOTLIN_DIR, HANDWRITTEN_FILES_KOTLIN, SCHEMAS_DIR } from './lib/paths.js';
import { generateKotlinFile } from './lib/kotlin_codegen.js';

// W4.5 B3 · 不再 rmSync 整目录——会静默删掉 generated/kotlin/ 内的手写常驻
// SSOT 占位（譬如 StreamEventIdValidator.kt）。改为只删 codegen 自己生成
// 过的非 handwritten 文件。allow-list 见 lib/paths.ts::HANDWRITTEN_FILES_KOTLIN。
if (existsSync(GENERATED_KOTLIN_DIR)) {
  for (const entry of readdirSync(GENERATED_KOTLIN_DIR)) {
    if (HANDWRITTEN_FILES_KOTLIN.has(entry)) continue;
    unlinkSync(resolve(GENERATED_KOTLIN_DIR, entry));
  }
} else {
  mkdirSync(GENERATED_KOTLIN_DIR, { recursive: true });
}

const schemaFiles = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith('.json'));
console.log(`[05_gen_kotlin] 准备生成 ${schemaFiles.length} 个 Kotlin 文件...`);

let okCount = 0;
let failCount = 0;
const allEmittedTypes = new Set<string>();

for (const schemaFile of schemaFiles) {
  const baseName = schemaFile.replace(/\.json$/, '');
  const inputPath = resolve(SCHEMAS_DIR, schemaFile);
  const outputPath = resolve(GENERATED_KOTLIN_DIR, `${pascalCase(baseName)}.kt`);

  try {
    const schema = JSON.parse(readFileSync(inputPath, 'utf-8'));
    const code = generateKotlinFile(schema, baseName, allEmittedTypes);
    writeFileSync(outputPath, code);
    console.log(`  ✔ ${pascalCase(baseName)}.kt`);
    okCount++;
  } catch (e) {
    console.error(`  ✘ ${schemaFile}: ${(e as Error).message}\n${(e as Error).stack}`);
    failCount++;
  }
}

console.log(`\n[05_gen_kotlin] 完成：${okCount} ok, ${failCount} fail → ${GENERATED_KOTLIN_DIR}`);
if (failCount > 0) process.exit(1);

function pascalCase(snake: string): string {
  return snake
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

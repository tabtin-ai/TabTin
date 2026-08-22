/**
 * 路径常量集中管理（避免各 script 重复硬编码）。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** packages/wire-codegen/ 包根目录 */
export const PKG_ROOT = resolve(__dirname, '..', '..');

/** monorepo 根目录 */
export const REPO_ROOT = resolve(PKG_ROOT, '..', '..');

/** 中间产物：JSON Schema 与 fixture 样本 */
export const FIXTURES_DIR = resolve(PKG_ROOT, 'fixtures');
export const SCHEMAS_DIR = resolve(FIXTURES_DIR, 'json-schemas');
export const FIXTURE_SAMPLES_DIR = resolve(FIXTURES_DIR, 'samples');

/**
 * Codegen 顶级 artifact——4 端类型代码（W1 实质检查 P2-A 修复后从
 * `fixtures/generated/` 上移到 `generated/`，避免 Wave 2-6 看到顶级目录是空的迷惑）。
 * Wave 2-6 不直接 import 这里——读 4 端各自的 vendor 目录（07_vendor_in 拷贝过去）。
 */
export const GENERATED_DIR = resolve(PKG_ROOT, 'generated');
export const GENERATED_PYTHON_DIR = resolve(GENERATED_DIR, 'python');
export const GENERATED_SWIFT_DIR = resolve(GENERATED_DIR, 'swift');
export const GENERATED_KOTLIN_DIR = resolve(GENERATED_DIR, 'kotlin');
export const GENERATED_TS_DIR = resolve(GENERATED_DIR, 'typescript');

/** vendor in 各端目标路径（实测 4 端工程结构后选定） */
export const VENDOR_PATHS = {
  electron: resolve(REPO_ROOT, 'apps/tabtin-electron/src/shared/wire-generated'),
  ios: resolve(REPO_ROOT, 'apps/tabtin-ios/tabtin-ios-odd/TabTin/Sources/Models/Wire'),
  // 新 iOS 客户端。旧 tabtin-ios 暂存于 apps/tabtin-ios/tabtin-ios-odd。
  iosRebuild: resolve(REPO_ROOT, 'apps/tabtin-ios/Tabtin/Core/Wire'),
  android: resolve(
    REPO_ROOT,
    'apps/tabtin-android/app/src/main/java/com/tabtin/mobile/data/wire',
  ),
  django: resolve(REPO_ROOT, 'apps/tabtin_django/apps/services/wire_generated'),
} as const;

/**
 * `generated/{swift,kotlin}/` 内的**手写常驻 SSOT 占位**白名单。
 *
 * 这些文件不是 04_gen_swift / 05_gen_kotlin 自动生成的（这俩 script 是基于
 * stream-content-block.ts zod JSON Schema 派生的结构化类型代码），而是**跨
 * 语言函数行为契约**的手写实现——譬如 W4.5 B3 的 `isStreamEventId` 跨语言
 * 契约，需要在 4 端给出 byte-by-byte 一致的判定。
 *
 * Source of truth：`packages/agent-wire/src/cross-lang-validators/`。
 * Fixture：`packages/agent-wire/src/cross-lang-fixtures/`。
 *
 * **codegen pipeline 必须保留这些文件**：原先 04/05 script 用
 * `rmSync(dir, { recursive: true })` 清空目录会让手写占位被静默删除——下次
 * codegen 跑完 vendor_in 把空空的 generated/ 拷到 mobile 端，跨语言契约
 * 静默失效。本 allow-list 拦截这个 silent bypass。
 */
export const HANDWRITTEN_FILES_SWIFT: ReadonlySet<string> = new Set<string>([
  // W4.5 B3 · isStreamEventId 跨语言契约 SSOT 占位（iOS / W5）
  'StreamEventIdValidator.swift',
]);
export const HANDWRITTEN_FILES_KOTLIN: ReadonlySet<string> = new Set<string>([
  // W4.5 B3 · isStreamEventId 跨语言契约 SSOT 占位（Android / W6）
  'StreamEventIdValidator.kt',
]);

/** 工具路径（PoC 阶段固定，Wave 2+ 可改 env 变量） */
export const TOOLS = {
  /** Python venv 路径 —— 包内本地 .venv（packages/wire-codegen/.venv） */
  pythonVenv: resolve(PKG_ROOT, '.venv'),
  /** datamodel-codegen 二进制 */
  datamodelCodegen: resolve(PKG_ROOT, '.venv/bin/datamodel-codegen'),
  /** kotlinc 二进制（W0 PoC 装在 /tmp/kotlinc/bin/kotlinc） */
  kotlinc: '/tmp/kotlinc/bin/kotlinc',
  /** Klaxon JAR（不再使用——切到 kotlinx-serialization） */
  klaxonJar: '/tmp/klib/klaxon.jar',
  /** kotlin-reflect JAR */
  kotlinReflectJar: '/tmp/klib/kotlin-reflect.jar',
  /** kotlinx-serialization-json JAR */
  kotlinxSerializationJar: '/tmp/klib/kotlinx-serialization-json.jar',
} as const;

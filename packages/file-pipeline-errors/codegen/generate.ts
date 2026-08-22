#!/usr/bin/env tsx
/**
 * File Pipeline error_kind Codegen（W5 L17 / Wave 3）
 *
 * 从 `error-codes.yaml` SSoT 派生 5 个目标文件：
 *   1. ../src/_generated/error-codes.generated.ts
 *      （4 个核心常量 + jsdoc）
 *   2. apps/tabtin-electron/src/renderer/src/i18n/locales/zh-CN/chat.json
 *      （仅替换 toolError 段中 N 个 file pipeline kind keys）
 *   3. apps/tabtin-electron/src/renderer/src/i18n/locales/en-US/chat.json 同款
 *   4. apps/tabtin-android/app/src/main/res/values/strings_chat.xml
 *      （仅替换 N 个 <string name="chat_tool_error_*"> elements）
 *   5. apps/tabtin-android/app/src/main/res/values-en/strings_chat.xml 同款
 *
 * 用法：
 *   pnpm --filter @tabtin/file-pipeline-errors codegen          # 派生（覆盖现有文件）
 *   pnpm --filter @tabtin/file-pipeline-errors codegen:verify   # 校验 diff 0（不写文件）
 *
 * **非破坏性 codegen 原则**：
 *   - chat.json 只 mutate `toolError` 段中的 file pipeline kind keys，
 *     不影响其它顶层字段 / toolError 段中其它非 file pipeline keys（budget_skipped /
 *     tool_timeout / execute_error 等通用 runtime kind 由其它模块维护）
 *   - strings_chat.xml 只 in-place replace 14 个 <string name="chat_tool_error_*">
 *     elements；其它 string elements / 注释 / XML 缩进保留原状
 *
 * 校验失败时（`codegen:verify`）会打印 diff 让人工确认 SSoT 与手写文件一致。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// ────────────────────────────────────────────────────────────────────
// 基础路径解析
// ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, '..');
// monorepo root：codegen 在 packages/file-pipeline-errors/codegen，回退 3 级
const REPO_ROOT = resolve(PKG_ROOT, '../..');

const YAML_PATH = resolve(__dirname, 'error-codes.yaml');

const TARGETS = {
  generatedTs: resolve(PKG_ROOT, 'src/_generated/error-codes.generated.ts'),
  electronZh: resolve(
    REPO_ROOT,
    'apps/tabtin-electron/src/renderer/src/i18n/locales/zh-CN/chat.json',
  ),
  electronEn: resolve(
    REPO_ROOT,
    'apps/tabtin-electron/src/renderer/src/i18n/locales/en-US/chat.json',
  ),
  androidZh: resolve(
    REPO_ROOT,
    'apps/tabtin-android/app/src/main/res/values/strings_chat.xml',
  ),
  androidEn: resolve(
    REPO_ROOT,
    'apps/tabtin-android/app/src/main/res/values-en/strings_chat.xml',
  ),
} as const;

// ────────────────────────────────────────────────────────────────────
// YAML schema 解析
// ────────────────────────────────────────────────────────────────────

interface ErrorCodeI18nLocale {
  zh: string;
  en: string;
}

interface ErrorCodeEntry {
  enum: string;
  kind: string;
  i18n_key: string;
  description: string;
  i18n: {
    electron: ErrorCodeI18nLocale;
    android: ErrorCodeI18nLocale;
  };
}

interface YamlDoc {
  codes: ErrorCodeEntry[];
}

function loadYaml(): ErrorCodeEntry[] {
  const raw = readFileSync(YAML_PATH, 'utf-8');
  const doc = parseYaml(raw) as YamlDoc;
  if (!doc?.codes || !Array.isArray(doc.codes)) {
    throw new Error(`error-codes.yaml: missing or malformed top-level 'codes' array`);
  }
  validateEntries(doc.codes);
  return doc.codes;
}

function validateEntries(entries: ErrorCodeEntry[]): void {
  const seenEnum = new Set<string>();
  const seenKind = new Set<string>();
  const seenI18nKey = new Set<string>();

  for (const e of entries) {
    if (!e.enum || !/^[A-Z][A-Z0-9_]*$/.test(e.enum)) {
      throw new Error(`Invalid enum name: ${JSON.stringify(e.enum)}`);
    }
    if (!e.kind || !/^[a-z][a-z0-9_]*$/.test(e.kind)) {
      throw new Error(`Invalid kind: ${JSON.stringify(e.kind)} (enum=${e.enum})`);
    }
    if (!e.i18n_key || !/^[a-z][a-z0-9_]*$/.test(e.i18n_key)) {
      throw new Error(`Invalid i18n_key: ${JSON.stringify(e.i18n_key)} (enum=${e.enum})`);
    }
    if (seenEnum.has(e.enum)) throw new Error(`Duplicate enum: ${e.enum}`);
    if (seenKind.has(e.kind)) throw new Error(`Duplicate kind: ${e.kind}`);
    if (seenI18nKey.has(e.i18n_key)) {
      throw new Error(`Duplicate i18n_key: ${e.i18n_key} (enum=${e.enum})`);
    }
    seenEnum.add(e.enum);
    seenKind.add(e.kind);
    seenI18nKey.add(e.i18n_key);

    if (!e.i18n?.electron?.zh || !e.i18n?.electron?.en) {
      throw new Error(`Missing electron i18n for enum=${e.enum}`);
    }
    if (!e.i18n?.android?.zh || !e.i18n?.android?.en) {
      throw new Error(`Missing android i18n for enum=${e.enum}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 派生：_generated/error-codes.generated.ts
// ────────────────────────────────────────────────────────────────────

const TS_HEADER = `/**
 * **AUTO-GENERATED — DO NOT EDIT BY HAND**
 *
 * Source: packages/file-pipeline-errors/codegen/error-codes.yaml
 * Codegen: pnpm --filter @tabtin/file-pipeline-errors codegen
 *
 * 派生 3 个核心常量：
 *   - FilePipelineErrorCode (string enum / error_kind)
 *   - FILE_PIPELINE_ERROR_KINDS (string union 完整列表)
 *   - FILE_PIPELINE_ERROR_I18N_KEYS (string → i18n key 映射)
 *
 * Wave 3：不再生成 FILE_PIPELINE_ERROR_NUMERIC（数字 TabcodeErrorCode 协议已删除）。
 *
 * 加新错误码 / 改字面值 → 改 error-codes.yaml → 跑 codegen → 跑 codegen:verify。
 * 严禁直接编辑本文件——下次 codegen 会覆盖。
 */
`;

function generateTs(entries: ErrorCodeEntry[]): string {
  const enumLines = entries.map(e => `  ${e.enum}: '${e.kind}',`).join('\n');
  const kindLines = entries.map(e => `  FilePipelineErrorCode.${e.enum},`).join('\n');
  const i18nKeyLines = entries
    .map(e => `  [FilePipelineErrorCode.${e.enum}]: '${e.i18n_key}',`)
    .join('\n');

  return `${TS_HEADER}
export const FilePipelineErrorCode = {
${enumLines}
} as const;

export type FilePipelineErrorCode =
  (typeof FilePipelineErrorCode)[keyof typeof FilePipelineErrorCode];

export const FILE_PIPELINE_ERROR_KINDS: readonly FilePipelineErrorCode[] = [
${kindLines}
] as const;

export const FILE_PIPELINE_ERROR_I18N_KEYS: Readonly<
  Record<FilePipelineErrorCode, string>
> = {
${i18nKeyLines}
};
`;
}

// ────────────────────────────────────────────────────────────────────
// 派生：chat.json (zh-CN / en-US) toolError 段 in-place merge
// ────────────────────────────────────────────────────────────────────

/**
 * **非破坏性 in-place text replace**：不 parse JSON / 不 stringify 整个文件，
 * 只用 regex 定位 `toolError` 段中具名 file pipeline kind 字段的 string 字面值
 * 替换。原 JSON 缩进不一致（chat.json 历史上有混合 4-space / 6-space 缩进区段）
 * 不会被"标准化重排"——保持原状最大化降低 reviewer cognitive load。
 *
 * 设计取舍：
 *   - **JSON.parse + stringify** 会把所有缩进 normalize 为均匀 2-space，diff
 *     爆 100+ 行噪音（用户看到 chat.json 大段 diff 立即觉得 codegen 有 bug）
 *   - **in-place text replace** 只动目标 14 行（每条 entry 一行），diff 干净
 *     （仅 file pipeline kind 文案微调）；代价是依赖文件中字段格式假设
 *     （`"<key>": "<value>",` 单行字面值）—— file pipeline 13 类历史一直
 *     是这种格式，不变。
 *   - 缺失 entry 时 throw 让 codegen 提前失败：reviewer 必须先在 chat.json
 *     toolError 段加 stub `"<new_kind>": "TODO"` 后重跑 codegen 才生效——
 *     避免 codegen 自动 append 到任意位置。
 *
 * **JSON 字符串字面值 escape**：电子端 chat.json 用 `\\` `\"` 转义，与 Node
 * `JSON.stringify` 输出一致；但因为这里走 text replace，必须手动 escape 文案
 * 中的 `\\` `\"` `\n` 等保留字符。
 */
function jsonStringEscape(text: string): string {
  // 不调 JSON.stringify(text)（会包外层引号），手写 4 类必要 escape：
  //   \\ → \\\\   " → \"   newline → \n   tab → \t   carriage return → \r
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function mergeElectronChatJson(
  existing: string,
  entries: ErrorCodeEntry[],
  locale: 'zh' | 'en',
): string {
  // 找 `"toolError": { ... }` 段的 char range（balanced brace）
  const startMatch = existing.match(/"toolError"\s*:\s*\{/);
  if (!startMatch) {
    throw new Error(`chat.json: missing '"toolError": {' section`);
  }
  const segStart = startMatch.index! + startMatch[0].length - 1; // 落在 '{' 上
  let depth = 0;
  let segEnd = -1;
  for (let i = segStart; i < existing.length; i++) {
    const ch = existing[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        segEnd = i;
        break;
      }
    }
  }
  if (segEnd === -1) {
    throw new Error(`chat.json: unterminated 'toolError' section`);
  }
  const before = existing.slice(0, segStart + 1);
  let segBody = existing.slice(segStart + 1, segEnd);
  const after = existing.slice(segEnd);

  // 嗅探 toolError 段内 entry 的缩进（取首个 `"<key>": "..."` 前面的空白）
  const indentMatch = segBody.match(/\n([ \t]+)"[A-Za-z_]/);
  const entryIndent = indentMatch ? indentMatch[1] : '    ';

  // 收集 segBody 末尾**最后一个非空行**之后到 `}` 之前的尾部空白 — 用于 append
  // 新 entry 时拼接得"缩进风格与已有 entry 一致"。
  const trailingWsMatch = segBody.match(/(\s*)$/);
  const trailingWs = trailingWsMatch ? trailingWsMatch[1] : '\n  ';
  const segBodyTrimmed = segBody.slice(0, segBody.length - trailingWs.length);

  const toAppend: string[] = [];

  for (const e of entries) {
    const value = jsonStringEscape(e.i18n.electron[locale]);
    // 单行字面值格式：`"<kind>": "<...任意字面值，含转义>"`，结尾可有 `,`
    // 用非贪婪 .*? 不跨行；锚定 `"<kind>"` 前缀避免误命中相似前缀的 key
    const re = new RegExp(
      `("${e.kind}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`,
      'g',
    );
    if (re.test(segBody)) {
      re.lastIndex = 0;
      segBody = segBody.replace(re, `$1"${value}"`);
    } else {
      // 不存在 → 拼为 append 候选；最终在 segBody 末尾 append（保证最后一条
      // entry 末尾有逗号，新 entry 也以逗号结尾，最后一条新 entry 不带逗号）
      toAppend.push(`${entryIndent}"${e.kind}": "${value}"`);
    }
  }

  if (toAppend.length === 0) {
    return before + segBody + after;
  }

  // 在已有 entry 区域末尾追加 — 兼容两种风格：
  //   (a) 末尾 entry 末尾已有 `,` → 直接拼新 entries
  //   (b) 末尾 entry 末尾**没有** `,`（JSON 标准）→ 给末尾 entry 补 `,`
  // 通过定位 segBody 倒数第一个 `"` 之前的字符是否是 `,` 来判定。
  // 简化处理：找 segBodyTrimmed 末尾，剥掉行尾空白后看末字符。
  const trimmedRight = segBodyTrimmed.replace(/\s+$/, '');
  let workBody = segBodyTrimmed;
  if (trimmedRight.length > 0 && trimmedRight[trimmedRight.length - 1] !== ',') {
    // 末尾 entry 无逗号 → 给它补一个；保留原本被剥掉的 trailing 空白
    const tail = segBodyTrimmed.slice(trimmedRight.length);
    workBody = trimmedRight + ',' + tail;
  }
  // 拼新 entries：每条之间 `,\n`，最后一条不带 `,`
  const appendBlock = '\n' + toAppend.join(',\n');
  return before + workBody + appendBlock + trailingWs + after;
}

// ────────────────────────────────────────────────────────────────────
// 派生：strings_chat.xml in-place replace 14 个 chat_tool_error_* string elements
// ────────────────────────────────────────────────────────────────────

function escapeXml(text: string): string {
  // Android XML 字符串需 escape 单引号 + apostrophe（撇号）+ <、>、&
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, "\\'");
}

function mergeAndroidStringsXml(
  existing: string,
  entries: ErrorCodeEntry[],
  locale: 'zh' | 'en',
): string {
  let result = existing;
  for (const e of entries) {
    const name = `chat_tool_error_${e.kind}`;
    const text = escapeXml(e.i18n.android[locale]);
    const elementRegex = new RegExp(
      `<string\\s+name="${name}">[^<]*</string>`,
      'g',
    );
    if (!elementRegex.test(result)) {
      throw new Error(
        `Android strings_chat.xml: missing <string name="${name}"> element. Add it manually first then run codegen to populate.`,
      );
    }
    elementRegex.lastIndex = 0;
    result = result.replace(
      elementRegex,
      `<string name="${name}">${text}</string>`,
    );
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// CLI 入口
// ────────────────────────────────────────────────────────────────────

interface FileTask {
  label: string;
  path: string;
  expected: string;
}

function buildTasks(entries: ErrorCodeEntry[]): FileTask[] {
  const tasks: FileTask[] = [];

  // 1. _generated/error-codes.generated.ts
  tasks.push({
    label: 'generated TS',
    path: TARGETS.generatedTs,
    expected: generateTs(entries),
  });

  // 2. Electron chat.json zh-CN
  tasks.push({
    label: 'Electron chat.json zh-CN',
    path: TARGETS.electronZh,
    expected: mergeElectronChatJson(
      readFileSync(TARGETS.electronZh, 'utf-8'),
      entries,
      'zh',
    ),
  });

  // 3. Electron chat.json en-US
  tasks.push({
    label: 'Electron chat.json en-US',
    path: TARGETS.electronEn,
    expected: mergeElectronChatJson(
      readFileSync(TARGETS.electronEn, 'utf-8'),
      entries,
      'en',
    ),
  });

  // 4. Android strings_chat.xml values (zh)
  tasks.push({
    label: 'Android strings_chat.xml values (zh)',
    path: TARGETS.androidZh,
    expected: mergeAndroidStringsXml(
      readFileSync(TARGETS.androidZh, 'utf-8'),
      entries,
      'zh',
    ),
  });

  // 5. Android strings_chat.xml values-en (en)
  tasks.push({
    label: 'Android strings_chat.xml values-en (en)',
    path: TARGETS.androidEn,
    expected: mergeAndroidStringsXml(
      readFileSync(TARGETS.androidEn, 'utf-8'),
      entries,
      'en',
    ),
  });

  return tasks;
}

function writeAll(tasks: FileTask[]): void {
  for (const t of tasks) {
    const dir = dirname(t.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(t.path, t.expected, 'utf-8');
    console.log(`[codegen] WROTE ${t.label} → ${relative(REPO_ROOT, t.path)}`);
  }
}

function verifyAll(tasks: FileTask[]): boolean {
  let allClean = true;
  for (const t of tasks) {
    if (!existsSync(t.path)) {
      console.error(`[codegen:verify] MISSING ${t.label} → ${relative(REPO_ROOT, t.path)}`);
      allClean = false;
      continue;
    }
    const actual = readFileSync(t.path, 'utf-8');
    if (actual === t.expected) {
      console.log(`[codegen:verify] OK ${t.label}`);
      continue;
    }
    allClean = false;
    console.error(
      `\n[codegen:verify] DIFF ${t.label} → ${relative(REPO_ROOT, t.path)}`,
    );
    printDiff(actual, t.expected);
  }
  return allClean;
}

function relative(from: string, to: string): string {
  return to.startsWith(from) ? to.slice(from.length + 1) : to;
}

function printDiff(actual: string, expected: string): void {
  const aLines = actual.split('\n');
  const eLines = expected.split('\n');
  const max = Math.max(aLines.length, eLines.length);
  let firstDiff = -1;
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== eLines[i]) {
      firstDiff = i;
      break;
    }
  }
  if (firstDiff === -1) {
    console.error('  (files identical line-wise but byte mismatch — newline / encoding?)');
    return;
  }
  const start = Math.max(0, firstDiff - 2);
  const end = Math.min(max, firstDiff + 6);
  console.error(`  First diff at line ${firstDiff + 1}:`);
  for (let i = start; i < end; i++) {
    console.error(`    actual   [${i + 1}] ${aLines[i] ?? '<EOF>'}`);
    console.error(`    expected [${i + 1}] ${eLines[i] ?? '<EOF>'}`);
  }
}

function main(): void {
  const mode = process.argv[2] === '--verify' ? 'verify' : 'write';
  const entries = loadYaml();
  const tasks = buildTasks(entries);

  if (mode === 'write') {
    writeAll(tasks);
    console.log(`\n[codegen] Done — ${tasks.length} files written from ${entries.length} error codes.`);
    return;
  }

  const ok = verifyAll(tasks);
  if (!ok) {
    console.error(
      `\n[codegen:verify] FAIL — run \`pnpm --filter @tabtin/file-pipeline-errors codegen\` to regenerate.`,
    );
    process.exit(1);
  }
  console.log(`\n[codegen:verify] Clean — ${tasks.length} files match SSoT yaml (${entries.length} codes).`);
}

main();

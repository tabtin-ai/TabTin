#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const require = createRequire(import.meta.url);
const ts = require('typescript');

// **W1（2026-05-13）路径修复**：`new URL('../../../', import.meta.url).pathname`
// 在路径含非 ASCII 字符（如 `/Volumes/开发/`）时会百分号编码（`/Volumes/%E5%BC%80%E5%8F%91/`），
// readFileSync 拿到编码后的字符串就找不到文件，整个 collectAllowedErrorKinds 抛
// ENOENT 拖垮 70+ 测试。改用 `fileURLToPath` 显式解码。
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const runtimeRoot = join(repoRoot, 'packages/agent-runtime');
const mode = process.argv.includes('--hygiene') ? 'hygiene' : 'contract';
const fixtureArgIndex = process.argv.indexOf('--fixture');
const fixtureRoot = fixtureArgIndex >= 0 ? process.argv[fixtureArgIndex + 1] : undefined;
const roots = [
  join(runtimeRoot, 'src/tools'),
  join(runtimeRoot, 'src/capability'),
];

const HINT_OPTIONAL_KINDS = new Set([
  'INTERNAL_ERROR',
  'RUNTIME_MISCONFIG',
  'internal_error',
  'runtime_misconfig',
]);

const TRUSTED_METADATA_HELPERS = new Set([
  'toJsonErrorMetadata',
  'toTabcodeJsonErrorMetadata',
]);
const DANGEROUS_METADATA_KEYS = new Set([
  'upstream_label',
  'upstream_code',
  'error_code',
  'code',
  'detail',
  'debug',
  'traceback',
]);
const allowedKinds = collectAllowedErrorKinds();
const INTERNAL_LEAK_PATTERNS = [
  /context[_ ]?id is required/i,
  /caller must pass/i,
  /\bDjango\b/i,
  /\bqueryset\b/i,
  /serializer\.errors/i,
  /\brequest_dict\b/i,
  /\bTraceback\b/i,
  /\bValueError:/i,
  /\bKeyError:/i,
  /\bIntegrityError\b/i,
  /\bDoesNotExist\b/i,
  /\bValidationError\b/i,
  /\bNoneType\b/i,
];

const files = fixtureRoot ? collectFiles(fixtureRoot) : roots.flatMap((root) => collectFiles(root));
const violations = [];

for (const file of files) {
  const sourceText = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const objectBindings = collectObjectBindings(source);

  visit(source, (node) => {
    if (!isJsonErrorCall(node)) return;
    const loc = source.getLineAndCharacterOfPosition(node.getStart(source));
    const label = `${relative(repoRoot, file)}:${loc.line + 1}:${loc.character + 1}`;
    const [messageArg, metadataArg] = node.arguments;

    if (!metadataArg) {
      violations.push(`${label} jsonError must receive metadata with error_kind`);
      return;
    }

    const metadata = analyzeMetadata(metadataArg, objectBindings);
    if (!metadata.hasErrorKind) {
      violations.push(`${label} jsonError metadata is missing error_kind`);
    }
    for (const kind of metadata.errorKindValues) {
      if (!allowedKinds.values.has(kind) && !allowedKinds.symbols.has(kind)) {
        violations.push(`${label} jsonError uses unknown error_kind '${kind}'`);
      }
    }
    if (!metadata.hintOptional && !metadata.hasHint) {
      violations.push(`${label} jsonError metadata is missing actionable hint`);
    }

    if (mode === 'hygiene') {
      for (const key of metadata.dangerousMetadataKeys) {
        violations.push(`${label} jsonError metadata key '${key}' must go through a trusted safe metadata helper`);
      }
      for (const spread of metadata.unsafeSpreads) {
        violations.push(`${label} jsonError metadata spreads untrusted '${spread}'`);
      }
      const texts = [];
      const messageText = literalText(messageArg);
      if (messageText) texts.push(['message', messageText]);
      for (const hint of metadata.hintTexts) texts.push(['hint', hint]);
      for (const [field, text] of texts) {
        const pattern = INTERNAL_LEAK_PATTERNS.find((candidate) => candidate.test(text));
        if (pattern) {
          violations.push(`${label} ${field} leaks backend implementation detail matching ${pattern}`);
        }
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`[tool-error-${mode}] ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`[tool-error-${mode}] 0 violations across ${files.length} files`);

function collectFiles(root) {
  const stat = statSync(root);
  if (stat.isFile()) return [root];
  const out = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'dist' || entry === 'node_modules') continue;
      out.push(...collectFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function collectObjectBindings(source) {
  const bindings = new Map();
  visit(source, (node) => {
    if (!ts.isVariableDeclaration(node)) return;
    if (!ts.isIdentifier(node.name)) return;
    if (!node.initializer) return;
    const initializer = unwrapAssertion(node.initializer);
    if (!ts.isObjectLiteralExpression(initializer)) return;
    bindings.set(node.name.text, initializer);
  });
  return bindings;
}

function analyzeMetadata(node, objectBindings) {
  node = unwrapAssertion(node);
  if (ts.isObjectLiteralExpression(node)) return analyzeObjectLiteral(node, objectBindings);
  if (ts.isIdentifier(node) && objectBindings.has(node.text)) {
    return analyzeObjectLiteral(objectBindings.get(node.text), objectBindings);
  }
  if (isTrustedMetadataHelperCall(node)) {
    return { hasErrorKind: true, hasHint: true, hintOptional: false, hintTexts: [], errorKindValues: [], dangerousMetadataKeys: [], unsafeSpreads: [] };
  }
  return { hasErrorKind: false, hasHint: false, hintOptional: false, hintTexts: [], errorKindValues: [], dangerousMetadataKeys: [], unsafeSpreads: [] };
}

function unwrapAssertion(node) {
  while (node && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))) {
    node = node.expression;
  }
  return node;
}

function analyzeObjectLiteral(node, objectBindings) {
  let hasErrorKind = false;
  let hasHint = false;
  let hintOptional = false;
  const hintTexts = [];
  const errorKindValues = [];
  const dangerousMetadataKeys = [];
  const unsafeSpreads = [];

  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) {
      if (ts.isIdentifier(prop.expression) && objectBindings.has(prop.expression.text)) {
        const nested = analyzeObjectLiteral(objectBindings.get(prop.expression.text), objectBindings);
        hasErrorKind ||= nested.hasErrorKind;
        hasHint ||= nested.hasHint;
        hintOptional ||= nested.hintOptional;
        hintTexts.push(...nested.hintTexts);
        errorKindValues.push(...nested.errorKindValues);
        dangerousMetadataKeys.push(...nested.dangerousMetadataKeys);
      } else {
        unsafeSpreads.push(sourceTextFor(prop.expression));
      }
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      if (prop.name.text === 'hint') hasHint = true;
      continue;
    }
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = propName(prop.name);
    if (DANGEROUS_METADATA_KEYS.has(name)) {
      dangerousMetadataKeys.push(name);
    }
    if (name === 'error_kind') {
      hasErrorKind = true;
      const kind = literalText(prop.initializer)
        ?? (ts.isIdentifier(prop.initializer) && /^[A-Z0-9_]+$/.test(prop.initializer.text) ? prop.initializer.text : undefined);
      if (kind) errorKindValues.push(kind);
      if (kind && HINT_OPTIONAL_KINDS.has(kind)) hintOptional = true;
    }
    if (name === 'hint') {
      hasHint = true;
      const text = literalText(prop.initializer);
      if (text) hintTexts.push(text);
    }
  }

  return { hasErrorKind, hasHint, hintOptional, hintTexts, errorKindValues, dangerousMetadataKeys, unsafeSpreads };
}

function sourceTextFor(node) {
  if (!node) return '<unknown>';
  return node.getText?.() ?? '<unknown>';
}

function isTrustedMetadataHelperCall(node) {
  return ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && TRUSTED_METADATA_HELPERS.has(node.expression.text);
}

function propName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function literalText(node) {
  if (!node) return undefined;
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return literalText(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => span.literal.text).join('');
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(node.left);
    const right = literalText(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function isJsonErrorCall(node) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'jsonError';
}

function collectAllowedErrorKinds() {
  const values = new Set([
    'aborted',
    'aborted_by_user',
    'budget_skipped',
    'tool_timeout',
    'execute_error',
    'unknown_tool',
    'schema_invalid',
    'validate_input',
    'plan_guard_deny',
  ]);
  const symbols = new Set();

  // Wave 2: tool-layer string literals live in @tabtin/tool-errors generated SSoT.
  collectStringLiteralsFromFile(
    join(repoRoot, 'packages/tool-errors/src/_generated/kinds.generated.ts'),
    values,
  );
  // File-pipeline kinds remain in their own generated SSoT.
  collectStringLiteralsFromFile(
    join(repoRoot, 'packages/file-pipeline-errors/src/_generated/error-codes.generated.ts'),
    values,
  );

  // error-kinds.ts re-exports generated / file-pipeline constants. Register
  // SCREAMING_SNAKE symbols even when the initializer is no longer a string
  // literal (GENERATED_* alias or FilePipelineErrorCode.*).
  const file = join(runtimeRoot, 'src/engine/errors/error-kinds.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  visit(source, (node) => {
    if (!ts.isVariableDeclaration(node)) return;
    if (!ts.isIdentifier(node.name)) return;
    if (!node.initializer) return;
    if (/^[A-Z][A-Z0-9_]*$/.test(node.name.text)) {
      symbols.add(node.name.text);
    }
    const text = literalText(node.initializer);
    if (text) values.add(text);
  });
  return { values, symbols };
}

function collectStringLiteralsFromFile(filePath, values) {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  visit(source, (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (/^[a-z][a-z0-9_]*$/.test(node.text)) values.add(node.text);
    }
  });
}

function visit(node, cb) {
  cb(node);
  ts.forEachChild(node, (child) => visit(child, cb));
}

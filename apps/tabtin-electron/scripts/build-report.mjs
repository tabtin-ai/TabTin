import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const repoRootDir = path.resolve(appDir, '..', '..');
const rendererOutDirCandidates = [
  path.join(appDir, 'out', 'renderer'),
  path.join(repoRootDir, 'out', 'renderer'),
];
const DEFAULT_REPORT_PATH = '/tmp/tabtin-electron-build-report.json';

function resolveRendererOutDir() {
  return rendererOutDirCandidates.find((dirPath) => fs.existsSync(dirPath))
    ?? rendererOutDirCandidates[0];
}

function parseArgs(argv) {
  const args = { writePath: DEFAULT_REPORT_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--write' && argv[i + 1]) {
      args.writePath = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-9;]*m/g, '');
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function collectFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findChunkFile(assetStats, rendererDir, chunkPrefix) {
  const assetMatch = assetStats.find((asset) => (
    asset.file.endsWith('.js') && path.basename(asset.file).startsWith(`${chunkPrefix}-`)
  ));
  if (assetMatch) return assetMatch.file;

  const assetsDir = path.join(rendererDir, 'assets');
  if (!fs.existsSync(assetsDir)) return null;

  const fileName = fs.readdirSync(assetsDir).find((name) => (
    name.endsWith('.js') && name.startsWith(`${chunkPrefix}-`)
  ));
  if (!fileName) return null;

  return path.relative(appDir, path.join(assetsDir, fileName));
}

function parseRootHtml(rendererDir) {
  const htmlPath = path.join(rendererDir, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return {
      rootEntryFile: null,
      modulePreloads: [],
    };
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const entryMatch = html.match(/<script\b[^>]*\bsrc="\.\/assets\/([^"]+\.js)"[^>]*>/i);
  const preloadMatches = [...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="\.\/assets\/([^"]+\.js)"[^>]*>/gi)];

  return {
    rootEntryFile: entryMatch
      ? path.relative(appDir, path.join(rendererDir, 'assets', entryMatch[1]))
      : null,
    modulePreloads: preloadMatches
      .map((match) => path.relative(appDir, path.join(rendererDir, 'assets', match[1])))
      .sort(),
  };
}

function findStaticImporters(assetStats, targetFile) {
  if (!targetFile) return [];
  const targetBasename = path.basename(targetFile);
  const importPattern = new RegExp(
    `^\\s*import(?:[\\s\\S]*?from\\s*)?["']\\./${escapeRegExp(targetBasename)}["']`,
    'gm',
  );

  return assetStats
    .filter((asset) => asset.file.endsWith('.js') && asset.file !== targetFile)
    .filter((asset) => {
      const assetPath = path.join(appDir, asset.file);
      try {
        const source = fs.readFileSync(assetPath, 'utf8');
        return importPattern.test(source);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          return false;
        }
        throw error;
      }
    })
    .map((asset) => asset.file)
    .sort();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** exponent);
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 2)} ${units[exponent]}`;
}

function inspectRendererArtifacts() {
  const rendererOutDir = resolveRendererOutDir();
  const files = collectFiles(rendererOutDir);
  const assetStats = files.map((filePath) => {
    const stat = fs.statSync(filePath);
    return {
      file: path.relative(appDir, filePath),
      bytes: stat.size,
    };
  });

  const topAssets = assetStats
    .filter((asset) => !asset.file.endsWith('.map'))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 20)
    .map((asset) => ({
      file: asset.file,
      bytes: asset.bytes,
      size: formatBytes(asset.bytes),
    }));

  const jsMapBytes = assetStats
    .filter((asset) => asset.file.endsWith('.map'))
    .reduce((sum, asset) => sum + asset.bytes, 0);

  const vendorMonacoFile = findChunkFile(assetStats, rendererOutDir, 'vendor-monaco');
  const vendorRuntimeFile = findChunkFile(assetStats, rendererOutDir, 'vendor-runtime');
  const vendorTeableCoreFile = findChunkFile(assetStats, rendererOutDir, 'vendor-teable-core');
  const vendorTeableUiFile = findChunkFile(assetStats, rendererOutDir, 'vendor-teable-ui');
  const vendorTeableMiscFile = findChunkFile(assetStats, rendererOutDir, 'vendor-teable-misc');
  const vendorEditorFile = findChunkFile(assetStats, rendererOutDir, 'vendor-editor');
  const vendorUiFile = findChunkFile(assetStats, rendererOutDir, 'vendor-ui');
  const vendorReactFile = findChunkFile(assetStats, rendererOutDir, 'vendor-react');
  const vendorI18nFile = findChunkFile(assetStats, rendererOutDir, 'vendor-i18n');
  const { rootEntryFile, modulePreloads: rootModulePreloads } = parseRootHtml(rendererOutDir);
  const vendorMonacoStaticImporters = findStaticImporters(assetStats, vendorMonacoFile);
  const vendorRuntimeStaticImporters = findStaticImporters(assetStats, vendorRuntimeFile);
  const vendorTeableCoreStaticImporters = findStaticImporters(assetStats, vendorTeableCoreFile);
  const vendorTeableUiStaticImporters = findStaticImporters(assetStats, vendorTeableUiFile);
  const vendorTeableMiscStaticImporters = findStaticImporters(assetStats, vendorTeableMiscFile);
  const vendorEditorStaticImporters = findStaticImporters(assetStats, vendorEditorFile);
  const vendorUiStaticImporters = findStaticImporters(assetStats, vendorUiFile);
  const allowedVendorMonacoImporterPrefixes = ['CodeEditor-', 'TabCodeDiffView-', 'CheckpointDiffSheet-', 'monaco-setup-', 'useMonacoThemeSync-'];
  const allowedVendorTeableCoreImporterPrefixes = ['vendor-teable-ui-'];
  const allowedVendorTeableUiImporterPrefixes = [];
  const allowedVendorTeableMiscImporterPrefixes = ['vendor-teable-ui-'];
  const allowedRootPreloads = new Set(
    [vendorRuntimeFile, vendorReactFile, vendorI18nFile].filter(Boolean),
  );
  const unexpectedVendorMonacoStaticImporters = vendorMonacoStaticImporters.filter((file) => !allowedVendorMonacoImporterPrefixes.some((prefix) => path.basename(file).startsWith(prefix)));
  const unexpectedVendorTeableCoreStaticImporters = vendorTeableCoreStaticImporters.filter((file) => !allowedVendorTeableCoreImporterPrefixes.some((prefix) => path.basename(file).startsWith(prefix)));
  const unexpectedVendorTeableUiStaticImporters = vendorTeableUiStaticImporters.filter((file) => !allowedVendorTeableUiImporterPrefixes.some((prefix) => path.basename(file).startsWith(prefix)));
  const unexpectedVendorTeableMiscStaticImporters = vendorTeableMiscStaticImporters.filter((file) => !allowedVendorTeableMiscImporterPrefixes.some((prefix) => path.basename(file).startsWith(prefix)));
  const rootEntryImportsVendorEditor = Boolean(rootEntryFile && vendorEditorStaticImporters.includes(rootEntryFile));
  const rootEntryAsset = rootEntryFile
    ? assetStats.find((asset) => asset.file === rootEntryFile) ?? null
    : null;
  const unexpectedRootPreloads = rootModulePreloads.filter((file) => !allowedRootPreloads.has(file));

  return {
    outputDir: rendererOutDir,
    exists: fs.existsSync(rendererOutDir),
    fileCount: assetStats.length,
    mapBytes: jsMapBytes,
    mapSize: formatBytes(jsMapBytes),
    topAssets,
    chunkGraph: {
      rootEntryFile,
      rootEntrySize: rootEntryAsset?.bytes ?? null,
      rootEntrySizeLabel: rootEntryAsset ? formatBytes(rootEntryAsset.bytes) : null,
      rootModulePreloads,
      unexpectedRootPreloads,
      vendorMonacoFile,
      vendorRuntimeFile,
      vendorTeableCoreFile,
      vendorTeableUiFile,
      vendorTeableMiscFile,
      vendorEditorFile,
      vendorUiFile,
      vendorReactFile,
      vendorI18nFile,
      vendorMonacoStaticImporters,
      vendorRuntimeStaticImporters,
      vendorTeableCoreStaticImporters,
      vendorTeableUiStaticImporters,
      vendorTeableMiscStaticImporters,
      vendorEditorStaticImporters,
      vendorUiStaticImporters,
      unexpectedVendorMonacoStaticImporters,
      unexpectedVendorTeableCoreStaticImporters,
      unexpectedVendorTeableUiStaticImporters,
      unexpectedVendorTeableMiscStaticImporters,
      rootEntryImportsVendorEditor,
    },
  };
}

function analyzeLogs(rawOutput) {
  const output = stripAnsi(rawOutput);
  const circularChunkLines = [...new Set(output.match(/^.*Circular chunk:.*$/gm) ?? [])];
  const unresolvedStyles = /failed to resolve import ['"]@tabtin\/smartsheet-ui\/styles['"]/i.test(output)
    || (/resolve import/i.test(output) && /@tabtin\/smartsheet-ui\/styles/i.test(output));

  return {
    dynamicImportConflictCount: countMatches(output, /dynamic import will not move module into another chunk/gi),
    circularChunkCount: circularChunkLines.length,
    circularChunkLines,
    oomDetected: /(Reached heap limit|heap out of memory|Allocation failed)/i.test(output),
    unresolvedSmartsheetUiStyles: unresolvedStyles,
  };
}

function writeReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function run() {
  const { writePath } = parseArgs(process.argv.slice(2));
  const buildOutput = [];

  const child = spawn('pnpm', ['build'], {
    cwd: appDir,
    env: { ...process.env, TABTIN_BUILD_REPORT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    buildOutput.push(text);
    process.stdout.write(text);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    buildOutput.push(text);
    process.stderr.write(text);
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  const logs = buildOutput.join('');
  const warnings = analyzeLogs(logs);
  const artifacts = inspectRendererArtifacts();
  const report = {
    generatedAt: new Date().toISOString(),
    command: 'pnpm build',
    appDir,
    build: {
      exitCode,
      success: exitCode === 0,
    },
    warnings,
    artifacts,
  };

  writeReport(writePath, report);

  console.log('\n[build-report] 构建摘要');
  console.log(`[build-report] report: ${writePath}`);
  console.log(`[build-report] dynamic import/static import 冲突: ${warnings.dynamicImportConflictCount}`);
  console.log(`[build-report] circular chunk: ${warnings.circularChunkCount}`);
  console.log(`[build-report] sourcemap 总量: ${artifacts.mapSize}`);
  console.log(`[build-report] vendor-monaco 静态引用者: ${artifacts.chunkGraph.vendorMonacoStaticImporters.length}`);
  console.log(`[build-report] vendor-runtime 静态引用者: ${artifacts.chunkGraph.vendorRuntimeStaticImporters.length}`);
  console.log(`[build-report] vendor-teable-core 静态引用者: ${artifacts.chunkGraph.vendorTeableCoreStaticImporters.length}`);
  console.log(`[build-report] vendor-teable-ui 静态引用者: ${artifacts.chunkGraph.vendorTeableUiStaticImporters.length}`);
  console.log(`[build-report] vendor-teable-misc 静态引用者: ${artifacts.chunkGraph.vendorTeableMiscStaticImporters.length}`);
  console.log(`[build-report] vendor-editor 静态引用者: ${artifacts.chunkGraph.vendorEditorStaticImporters.length}`);
  console.log(`[build-report] vendor-ui 静态引用者: ${artifacts.chunkGraph.vendorUiStaticImporters.length}`);
  if (artifacts.chunkGraph.rootEntryFile) {
    console.log(`[build-report] root entry: ${artifacts.chunkGraph.rootEntryFile}`);
    if (artifacts.chunkGraph.rootEntrySizeLabel) {
      console.log(`[build-report] root entry 大小: ${artifacts.chunkGraph.rootEntrySizeLabel}`);
    }
    console.log(`[build-report] root entry 静态引用 vendor-editor: ${artifacts.chunkGraph.rootEntryImportsVendorEditor ? 'yes' : 'no'}`);
    console.log(`[build-report] root preload: ${artifacts.chunkGraph.rootModulePreloads.join(', ') || '(none)'}`);
  }
  if (artifacts.chunkGraph.unexpectedVendorMonacoStaticImporters.length > 0) {
    console.log(`[build-report] unexpected vendor-monaco 引用: ${artifacts.chunkGraph.unexpectedVendorMonacoStaticImporters.join(', ')}`);
  }
  if (artifacts.chunkGraph.unexpectedVendorTeableCoreStaticImporters.length > 0) {
    console.log(`[build-report] unexpected vendor-teable-core 引用: ${artifacts.chunkGraph.unexpectedVendorTeableCoreStaticImporters.join(', ')}`);
  }
  if (artifacts.chunkGraph.unexpectedVendorTeableUiStaticImporters.length > 0) {
    console.log(`[build-report] unexpected vendor-teable-ui 引用: ${artifacts.chunkGraph.unexpectedVendorTeableUiStaticImporters.join(', ')}`);
  }
  if (artifacts.chunkGraph.unexpectedVendorTeableMiscStaticImporters.length > 0) {
    console.log(`[build-report] unexpected vendor-teable-misc 引用: ${artifacts.chunkGraph.unexpectedVendorTeableMiscStaticImporters.join(', ')}`);
  }
  if (artifacts.chunkGraph.unexpectedRootPreloads.length > 0) {
    console.log(`[build-report] unexpected root preload: ${artifacts.chunkGraph.unexpectedRootPreloads.join(', ')}`);
  }
  for (const asset of artifacts.topAssets.slice(0, 10)) {
    console.log(`[build-report] top asset: ${asset.file} (${asset.size})`);
  }

  const shouldFail = exitCode !== 0
    || warnings.circularChunkCount > 0
    || warnings.oomDetected
    || warnings.unresolvedSmartsheetUiStyles
    || artifacts.chunkGraph.unexpectedVendorMonacoStaticImporters.length > 0
    || artifacts.chunkGraph.unexpectedVendorTeableCoreStaticImporters.length > 0
    || artifacts.chunkGraph.unexpectedVendorTeableUiStaticImporters.length > 0
    || artifacts.chunkGraph.unexpectedVendorTeableMiscStaticImporters.length > 0
    || artifacts.chunkGraph.unexpectedRootPreloads.length > 0
    || artifacts.chunkGraph.rootEntryImportsVendorEditor;

  if (shouldFail) {
    process.exit(typeof exitCode === 'number' && exitCode !== 0 ? exitCode : 1);
  }
}

run().catch((error) => {
  console.error('[build-report] 执行失败:', error);
  process.exit(1);
});

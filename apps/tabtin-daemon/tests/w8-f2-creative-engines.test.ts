/**
 * W8-F2: Creative Engines headless integration tests
 *
 * Verifies that daemon.ts properly initializes:
 *   - TabDoc (@tabtin/doc-editor) — local markdown↔pmJson conversion
 *   - Video export (@tabtin/media-capabilities) — FFmpeg availability check
 *
 * Also verifies that action-tools headless adapter registers the
 * expected tools for each engine.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const daemonSrc = readFileSync(join(ROOT, 'src', 'bootstrap', 'daemon.ts'), 'utf-8');
const detectorSrc = readFileSync(join(ROOT, 'src', 'platform', 'system', 'capability', 'detector.ts'), 'utf-8');
const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));

// ── TabDoc (@tabtin/doc-editor) ─────────────────────────────────────────

describe('W8-F2: TabDoc headless integration', () => {
  it('package.json declares @tabtin/doc-editor dependency', () => {
    expect(pkgJson.dependencies['@tabtin/doc-editor']).toBeDefined();
  });

  it('daemon.ts has initDocEditor method', () => {
    expect(daemonSrc).toContain('initDocEditor');
  });

  it('initDocEditor is called in start() in non-blocking background mode', () => {
    expect(daemonSrc).toContain('this.initDocEditor().catch(');
  });

  it('initDocEditor dynamically imports @tabtin/doc-editor', () => {
    expect(daemonSrc).toMatch(/await\s+import\(['"]@tabtin\/doc-editor['"]\)/);
  });

  it('initDocEditor validates markdownToPmJson and pmJsonToMarkdown exports', () => {
    expect(daemonSrc).toContain('markdownToPmJson');
    expect(daemonSrc).toContain('pmJsonToMarkdown');
  });

  it('tracks docEditorReady state', () => {
    expect(daemonSrc).toContain('docEditorReady');
  });

  it('sets docEditorReady = true on success', () => {
    expect(daemonSrc).toContain('this.docEditorReady = true');
  });

  it('sets docEditorReady = false on failure (graceful degradation)', () => {
    expect(daemonSrc).toContain('this.docEditorReady = false');
  });

  it('wraps initDocEditor in try/catch for graceful failure', () => {
    const methodMatch = daemonSrc.match(
      /private\s+async\s+initDocEditor[^}]+try\s*\{[\s\S]*?\}\s*catch/,
    );
    expect(methodMatch).not.toBeNull();
  });
});

// ── Video export (@tabtin/media-capabilities) ───────────────────────────

describe('W8-F2: video export headless integration', () => {
  it('package.json declares @tabtin/media-capabilities dependency', () => {
    expect(pkgJson.dependencies['@tabtin/media-capabilities']).toBeDefined();
  });

  it('package.json does not declare retired @tabtin/tabvideo-engine', () => {
    expect(pkgJson.dependencies['@tabtin/tabvideo-engine']).toBeUndefined();
  });

  it('daemon.ts has initVideoEngine method', () => {
    expect(daemonSrc).toContain('initVideoEngine');
  });

  it('initVideoEngine is called in start() in non-blocking background mode', () => {
    expect(daemonSrc).toContain('this.initVideoEngine().catch(');
  });

  it('uses CapabilityDetector results as the FFmpeg readiness source of truth', () => {
    expect(daemonSrc).toContain('hasDetectedVideoEngineCapabilities');
    expect(daemonSrc).toContain('this.ffmpegAvailable = this.hasDetectedVideoEngineCapabilities(capabilities)');
    expect(daemonSrc).toContain('this.ffmpegAvailable = this.hasDetectedVideoEngineCapabilities(freshCapabilities)');
    expect(daemonSrc).not.toContain('findFFmpegSync');
  });

  it('tracks ffmpegAvailable state', () => {
    expect(daemonSrc).toContain('ffmpegAvailable');
  });

  it('sets ffmpegAvailable from detected video capabilities', () => {
    expect(daemonSrc).toContain("capabilities.includes('video_render_mg') && capabilities.includes('video_export')");
  });

  it('does not scaffold retired tabvideo-engine Remotion projects', () => {
    expect(daemonSrc).not.toContain('warmUpRemotionDeps');
    expect(daemonSrc).not.toContain('scaffoldMgProject');
  });

  it('logs detector-verified FFmpeg readiness on success', () => {
    expect(daemonSrc).toMatch(/FFmpeg verified by capability detector/);
  });

  it('logs actionable warning when FFmpeg not found', () => {
    expect(daemonSrc).toMatch(/FFmpeg not verified by capability detector/);
  });
});

// ── action-tools headless adapter tool registration ─────────────────────

describe('W8-F2: Headless adapter registers creative engine tools', () => {
  it('headless adapter no longer includes removed tabvideo_build_and_export', async () => {
    const { createHeadlessAdapter } = await import('@tabtin/action-tools/headless');
    const adapter = createHeadlessAdapter();
    const tools = adapter.getRegisteredTools();

    expect(tools).not.toContain('tabvideo_build_and_export');
  });

  it('headless adapter no longer registers retired tabslide_* AgentTools (W6 2026-05-04)', async () => {
    const { createHeadlessAdapter } = await import('@tabtin/action-tools/headless');
    const adapter = createHeadlessAdapter();
    const tools = adapter.getRegisteredTools();

    expect(tools).not.toContain('tabslide_list_presentations');
    expect(tools).not.toContain('tabslide_get_presentation');
    expect(tools).not.toContain('tabslide_export_pptx');
  });
});

// ── Capability snapshot includes engine states ──────────────────────────

describe('W8-F2: buildHostRuntimeSnapshot includes creative engine states', () => {
  it('daemon.ts exposes creative_engines in snapshot', () => {
    expect(daemonSrc).toContain('creative_engines');
  });

  it('snapshot includes doc_editor module_loaded status', () => {
    expect(daemonSrc).toMatch(/doc_editor:\s*\{\s*module_loaded:\s*this\.docEditorReady/);
  });

  it('snapshot includes video_export ready status', () => {
    expect(daemonSrc).toMatch(/video_export:\s*\{\s*ready:\s*this\.ffmpegAvailable/);
  });

  it('snapshot includes video_render_mg ready status separately from video_export', () => {
    expect(daemonSrc).toMatch(/video_render_mg:\s*\{\s*ready:\s*this\.ffmpegAvailable/);
  });

  it('refresh updates snapshot readiness from the same capability detector result', () => {
    expect(daemonSrc).toMatch(/const freshCapabilities = await this\.capabilityDetector\.detect\(\)/);
    expect(daemonSrc).toContain('this.ffmpegAvailable = this.hasDetectedVideoEngineCapabilities(freshCapabilities)');
  });
});

// ── CapabilityDetector FFmpeg lookup parity ────────────────────────────

describe('W8-F2: CapabilityDetector video capability detection', () => {
  it('uses media-capabilities FFmpeg lookup before reporting video capabilities', () => {
    expect(detectorSrc).toContain('findFFmpegAsync');
    expect(detectorSrc).toContain("import('@tabtin/media-capabilities')");
  });

  it('does not gate video capabilities directly on commandExists(ffmpeg)', () => {
    expect(detectorSrc).not.toContain("if (this.commandExists('ffmpeg'))");
  });
});

// ── Startup ordering guard ──────────────────────────────────────────────

describe('W8-F2: Startup ordering', () => {
  it('all creative engine inits happen after injectGlobalTabtin', () => {
    const globalInjPos = daemonSrc.indexOf('this.injectGlobalTabtin()');
    const initDocPos = daemonSrc.indexOf('this.initDocEditor()');
    const initVideoPos = daemonSrc.indexOf('this.initVideoEngine()');

    expect(globalInjPos).toBeGreaterThan(-1);
    expect(initDocPos).toBeGreaterThan(globalInjPos);
    expect(initVideoPos).toBeGreaterThan(globalInjPos);
  });

  it('creative engine inits happen after bridge.registerCoreExecutors', () => {
    const regPos = daemonSrc.indexOf('this.bridge.registerCoreExecutors()');
    const initDocPos = daemonSrc.indexOf('this.initDocEditor()');
    const initVideoPos = daemonSrc.indexOf('this.initVideoEngine()');

    expect(regPos).toBeGreaterThan(-1);
    expect(initDocPos).toBeGreaterThan(regPos);
    expect(initVideoPos).toBeGreaterThan(regPos);
  });
});

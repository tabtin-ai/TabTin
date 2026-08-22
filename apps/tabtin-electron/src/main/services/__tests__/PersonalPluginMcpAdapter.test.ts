import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => 'test-version', isPackaged: false },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

const tempRoots: string[] = []

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Electron Cowart Personal Plugin MCP adapter', () => {
  it('attaches a runtime-scoped Cowart MCP session and runs a non-image canvas workflow', async () => {
    const { createElectronPersonalPluginMcpRuntimeAdapter } = await import('../PersonalPluginMarketplaceService')
    const adapter = createElectronPersonalPluginMcpRuntimeAdapter()
    const installPath = path.resolve(process.cwd(), '../../packages/apps/cowart')
    const projectDir = await tempRoot('tabtin-cowart-mcp-project-')

    const attached = await adapter.attach({
      runtimeId: 'personal-plugin:wt-1:space-1:agent-1:cowart',
      organizationId: 'wt-1',
      spaceId: 'space-1',
      agentId: 'agent-1',
      pluginId: 'cowart',
      installPath,
      projectDir,
      env: {
        COWART_PROJECT_DIR: projectDir,
        TABTIN_PLUGIN_INSTALL_PATH: installPath,
      },
      mcp: {
        path: '.mcp.json',
        serverCount: 1,
        raw: {
          mcpServers: {
            cowart_mcp: {
              command: 'bash',
              args: ['./scripts/start-mcp.sh'],
              cwd: '.',
            },
          },
        },
      },
    })

    expect(attached.tools).toEqual([
      expect.objectContaining({ name: 'mcp_cowart_read_canvas_state', isReadOnly: true }),
      expect.objectContaining({ name: 'mcp_cowart_insert_shape', isReadOnly: false }),
    ])

    await expect(adapter.callTool({
      runtimeId: 'personal-plugin:wt-1:space-1:agent-1:cowart',
      handle: attached.handle,
      toolName: 'mcp_cowart_read_canvas_state',
      input: {},
    })).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        projectDir,
        pluginInstallPath: installPath,
        state: { version: 1, elements: [] },
      },
    })

    await expect(adapter.callTool({
      runtimeId: 'personal-plugin:wt-1:space-1:agent-1:cowart',
      handle: attached.handle,
      toolName: 'mcp_cowart_insert_shape',
      input: { type: 'note', text: 'MCP acceptance note', x: 12, y: 34 },
    })).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        element: { type: 'note', text: 'MCP acceptance note', x: 12, y: 34 },
      },
    })

    const persisted = JSON.parse(
      await readFile(path.join(projectDir, '.cowart', 'canvas-state.json'), 'utf8'),
    )
    expect(persisted.elements).toEqual([
      expect.objectContaining({ type: 'note', text: 'MCP acceptance note', x: 12, y: 34 }),
    ])

    await adapter.detach(attached.handle)
    await expect(adapter.callTool({
      runtimeId: 'personal-plugin:wt-1:space-1:agent-1:cowart',
      handle: attached.handle,
      toolName: 'mcp_cowart_read_canvas_state',
      input: {},
    })).rejects.toThrow(/not attached/)
  })
})

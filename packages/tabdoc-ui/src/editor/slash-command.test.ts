import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readEditorSource(relativePath: string) {
  return readFileSync(resolve(process.cwd(), 'src/editor', relativePath), 'utf8')
}

describe('slash command collaboration origin gate wiring ', () => {
  it('wires isChangeOrigin gate ahead of suggestion allow', () => {
    const slashCommandSource = readEditorSource('slash-command.tsx')
    const originSource = readEditorSource('slash-command-origin.ts')

    expect(originSource).toContain('isChangeOrigin')
    expect(originSource).toContain('shouldAllowSlashSuggestion')
    expect(originSource).toContain('createSlashRemoteOriginGate')

    expect(slashCommandSource).toContain('createSlashRemoteOriginGate')
    expect(slashCommandSource).toContain('shouldAllowSlashSuggestion')
    expect(slashCommandSource).toContain('remoteOriginPlugin')
    expect(slashCommandSource).toMatch(/allow:\s*\(\{\s*isActive/)
    // origin plugin 必须排在 parent suggestion 之前
    expect(slashCommandSource).toContain('[remoteOriginPlugin, ...parentPlugins]')
  })
})

describe('slash command YouTube removal', () => {
  it('removes YouTube insert entry and host callback wiring', () => {
    const slashCommandSource = readEditorSource('slash-command.tsx')
    const viewStateSource = readEditorSource('useDocEditorViewState.ts')
    const shellSource = readEditorSource('DocEditorViewShell.tsx')
    const standaloneSource = readEditorSource('DocStandaloneEditor.tsx')

    expect(slashCommandSource).not.toContain('YoutubeIcon')
    expect(slashCommandSource).not.toContain('onRequestYoutubeUrl')
    expect(slashCommandSource).not.toContain("title: t('slash.youtube'")
    expect(slashCommandSource).not.toMatch(/\|\s*'youtube'\s*\n/)

    expect(viewStateSource).not.toContain('showYoutubeDialog')
    expect(viewStateSource).not.toContain('onRequestYoutubeUrl')
    expect(viewStateSource).not.toContain('setYoutubeVideo')

    expect(shellSource).not.toContain('showYoutubeDialog')
    expect(shellSource).not.toContain('slash.youtubePrompt')

    expect(standaloneSource).not.toContain('showYoutubeDialog')
    expect(standaloneSource).not.toContain('onRequestYoutubeUrl')
    expect(standaloneSource).not.toContain('setYoutubeVideo')
  })

  it('keeps Youtube extension for existing document nodes', () => {
    const extensionsSource = readEditorSource('extensions.ts')
    expect(extensionsSource).toContain('Youtube')
    expect(extensionsSource).toMatch(/\byoutube\b/)
  })
})

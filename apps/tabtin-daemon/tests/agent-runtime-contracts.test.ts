import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import type {
  DaemonHostStateContract,
  DaemonQueryRequestContract,
  RuntimeBuildInputContract,
} from '../src/application/agent/contracts.js'
import type {
  DaemonHostState,
  DaemonQueryRequest,
  RuntimeBuildInput,
} from '../src/application/agent/daemon-agent-host.js'

type Extends<Actual, Contract> = Actual extends Contract ? true : false

describe('agent runtime contracts seam', () => {
  it('keeps host-owned public types assignable to the independent contracts', () => {
    const checks: [
      Extends<DaemonQueryRequest, DaemonQueryRequestContract>,
      Extends<RuntimeBuildInput, RuntimeBuildInputContract>,
      Extends<DaemonHostState, DaemonHostStateContract>,
    ] = [true, true, true]
    expect(checks).toEqual([true, true, true])
  })

  it('makes assembly depend on contracts instead of importing its host', () => {
    const assemblyPath = resolve('src/application/agent/runtime/daemon-runtime-assembly.ts')
    const source = readFileSync(assemblyPath, 'utf8')
    const imports = ts.preProcessFile(source, true, true).importedFiles.map((item) => item.fileName)

    expect(imports).toContain('../contracts.js')
    expect(imports).not.toContain('../daemon-agent-host.js')
  })

  it('presents grouped session, terminal and skills behavior ports', () => {
    const assemblyPath = resolve('src/application/agent/runtime/daemon-runtime-assembly.ts')
    const source = readFileSync(assemblyPath, 'utf8')
    expect(source).toContain('readonly terminal: { current(): AgentTerminalPort | null }')
    expect(source).toContain('readonly session: {')
    expect(source).toContain('readonly skills: {')
    expect(source).not.toContain('readonly sessionState:')
    expect(source).not.toContain('getPtyManagerBridge:')
  })

  it('names each runtime assembly stage instead of hiding phases in async IIFEs', () => {
    const source = readFileSync(
      resolve('src/application/agent/runtime/daemon-runtime-assembly.ts'),
      'utf8',
    )

    for (const stage of [
      'assembleFoundation',
      'assembleSkills',
      'assemblePolicy',
      'assemblePrompt',
      'assembleCapabilities',
    ]) {
      expect(source).toContain(`const ${stage} = async () =>`)
      expect(source).toContain(`await ${stage}()`)
    }
    expect(source).toMatch(/const bootstrapBackend = async \(\): Promise<NativeBackendBootstrapResult \| null> =>/)
    expect(source).toContain('await bootstrapBackend()')

    expect(source).not.toMatch(/const \w+Assembly = await \(async \(\) =>/)
    expect(source).not.toContain('const foundation = await (async () =>')
    expect(source).not.toMatch(/await \(async \(\)/)
  })
})

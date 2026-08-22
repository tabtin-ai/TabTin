import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const SRC_ROOT = resolve(__dirname, '../src')

const LAYER_RANK: Record<string, number> = {
  base: 0,
  platform: 1,
  application: 2,
  transport: 3,
  bootstrap: 4,
  entrypoints: 5,
}

const RETIRED_TOP_LEVEL_DIRECTORIES = [
  'adapters',
  'capabilities',
  'host',
  'observability',
  'persistence',
  'runtime',
  'security',
  'shared',
]

const RETIRED_COMPATIBILITY_REEXPORTS = [
  'platform/system/config/types.ts',
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

function layerOf(path: string): string | undefined {
  return relative(SRC_ROOT, path).split(sep)[0]
}

function resolveLocalImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const unresolved = resolve(dirname(importer), specifier.replace(/\.js$/, ''))
  const candidates = [`${unresolved}.ts`, join(unresolved, 'index.ts')]
  return candidates.find((candidate) => existsSync(candidate))
}

function runtimeLocalImports(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const imports: string[] = []

  const add = (specifier: ts.Expression | undefined): void => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return
    const target = resolveLocalImport(file, specifier.text)
    if (target) imports.push(target)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const onlyTypeSpecifiers = bindings && ts.isNamedImports(bindings)
        ? bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)
        : false
      if (!clause?.isTypeOnly && !onlyTypeSpecifiers) add(node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause
      const onlyTypeSpecifiers = clause && ts.isNamedExports(clause)
        ? clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly)
        : false
      if (!node.isTypeOnly && !onlyTypeSpecifiers) add(node.moduleSpecifier)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return imports
}

function runtimeCycles(files: readonly string[]): string[][] {
  const graph = new Map(files.map((file) => [file, runtimeLocalImports(file)]))
  const completed = new Set<string>()
  const active = new Set<string>()
  const stack: string[] = []
  const cycles: string[][] = []

  const visit = (file: string): void => {
    if (completed.has(file)) return
    if (active.has(file)) {
      const start = stack.indexOf(file)
      cycles.push([...stack.slice(start), file].map((entry) => relative(SRC_ROOT, entry)))
      return
    }
    active.add(file)
    stack.push(file)
    for (const dependency of graph.get(file) ?? []) visit(dependency)
    stack.pop()
    active.delete(file)
    completed.add(file)
  }

  for (const file of files) visit(file)
  return cycles
}

describe('tabtin-daemon technical layer boundaries', () => {
  it('uses the agreed technical-layer vocabulary exclusively', () => {
    const topLevelDirectories = readdirSync(SRC_ROOT).filter((name) =>
      statSync(join(SRC_ROOT, name)).isDirectory(),
    )
    expect(topLevelDirectories.sort()).toEqual(
      ['application', 'base', 'bootstrap', 'entrypoints', 'platform', 'transport'],
    )
    expect(topLevelDirectories.filter((name) => RETIRED_TOP_LEVEL_DIRECTORIES.includes(name))).toEqual([])
  })

  it('allows dependencies only toward lower technical layers', () => {
    const violations: string[] = []
    for (const importer of sourceFiles(SRC_ROOT)) {
      const importerLayer = layerOf(importer)
      const importerRank = importerLayer ? LAYER_RANK[importerLayer] : undefined
      if (importerRank === undefined) continue
      const source = readFileSync(importer, 'utf8')
      for (const imported of ts.preProcessFile(source).importedFiles) {
        if (!imported.fileName.startsWith('.')) continue
        const target = normalize(resolve(dirname(importer), imported.fileName.replace(/\.js$/, '.ts')))
        const targetLayer = layerOf(target)
        const targetRank = targetLayer ? LAYER_RANK[targetLayer] : undefined
        if (targetRank !== undefined && targetRank > importerRank) {
          violations.push(
            `${relative(SRC_ROOT, importer)} (${importerLayer}) -> ${relative(SRC_ROOT, target)} (${targetLayer})`,
          )
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('has no runtime circular dependencies between source modules', () => {
    expect(runtimeCycles(sourceFiles(SRC_ROOT))).toEqual([])
  })

  it('keeps base free of Node.js I/O and process adapters', () => {
    const violations = sourceFiles(join(SRC_ROOT, 'base')).flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return ts.preProcessFile(source).importedFiles
        .filter(({ fileName }) => /^(node:)?(fs|path|url|child_process|process)(\/|$)/.test(fileName))
        .map(({ fileName }) => `${relative(SRC_ROOT, file)} -> ${fileName}`)
    })
    expect(violations).toEqual([])
  })

  it('keeps MCP transport limited to protocol concerns', () => {
    const transport = readFileSync(join(SRC_ROOT, 'transport/mcp/mcp-server.ts'), 'utf8')
    expect(transport).not.toMatch(/\btool(?:Table|Doc|Canvas|Memo|Sql|Site)/)
    expect(transport).not.toContain('TableKernelService')
    expect(transport).toContain('McpToolApplication')
  })

  it('keeps MCP application behind semantic runtime ports', () => {
    const application = readFileSync(join(SRC_ROOT, 'application/mcp/mcp-tool-application.ts'), 'utf8')
    expect(application).not.toMatch(/import .*TableKernelService/)
    expect(application).not.toMatch(/import .*createAuthedFetcher/)
    expect(application).not.toMatch(/from ['"]\.\.\/\.\.\/platform\//)
    const contracts = readFileSync(join(SRC_ROOT, 'application/mcp/contracts.ts'), 'utf8')
    expect(contracts).toContain('McpContentApiPort')
    expect(contracts).toContain('McpTablePort')
  })

  it('packages MCP handlers by domain and aggregates them through a registry', () => {
    const application = readFileSync(join(SRC_ROOT, 'application/mcp/mcp-tool-application.ts'), 'utf8')
    for (const domain of ['table', 'document', 'canvas', 'memo', 'sql', 'site']) {
      expect(existsSync(join(SRC_ROOT, `application/mcp/domains/${domain}.ts`))).toBe(true)
    }
    expect(application).toContain('McpDomainRegistry')
    expect(application).not.toMatch(/private async tool(?:Table|Doc|Canvas|Memo|Sql|Site)/)
    expect(application).not.toContain('executeLocalTool')
  })

  it('keeps storage application behind a filesystem port', () => {
    const application = readFileSync(join(SRC_ROOT, 'application/storage/daemon-storage.ts'), 'utf8')
    expect(application).not.toMatch(/from ['"]node:(?:fs|os)/)
    expect(application).toContain('StorageFileSystemPort')
    expect(application).not.toContain('StorageResponseSink')
    expect(application).not.toContain('SendOutcome')
  })

  it('rolls back partial TableKernel startup before clearing runtime state', () => {
    const bootstrap = readFileSync(join(SRC_ROOT, 'bootstrap/daemon.ts'), 'utf8')
    const startTableKernel = bootstrap.slice(
      bootstrap.indexOf('private async startTableKernel'),
      bootstrap.indexOf('private async startMcpServer'),
    )
    expect(startTableKernel).toContain('await localServer?.stop()')
    expect(startTableKernel).toContain('await kernel?.stop()')
    expect(startTableKernel.indexOf("this.lifecycle.own('table-kernel'")).toBeGreaterThan(
      startTableKernel.indexOf('await localServer.start()'),
    )
  })

  it('does not retain compatibility-only re-export modules', () => {
    const violations = sourceFiles(SRC_ROOT).filter((file) => {
      const source = readFileSync(file, 'utf8')
      const statements = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true).statements
      return source.includes('@deprecated') && statements.length > 0 && statements.every((statement) =>
        ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined,
      )
    }).map((file) => relative(SRC_ROOT, file))
    for (const retired of RETIRED_COMPATIBILITY_REEXPORTS) {
      if (existsSync(join(SRC_ROOT, retired))) violations.push(retired)
    }
    expect(violations).toEqual([])
  })

  it('keeps CLI routes free of module-level context locators', () => {
    const routeRoot = join(SRC_ROOT, 'transport/cli/routes')
    const routeFiles = sourceFiles(routeRoot)
    const violations = routeFiles.filter((file) => {
      const source = readFileSync(file, 'utf8')
      return /import\s*\{[^}]*\b(?:getCLI|setCLI|requireCLI)[A-Z][^}]*\}\s*from\s*['"][^'"]*cli-context/.test(source)
        || source.includes('process.env')
    })
    expect(violations).toEqual([])
    expect(readFileSync(join(SRC_ROOT, 'transport/cli/cli-context.ts'), 'utf8')).not.toContain('process.env')
  })
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const electronRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainSource = readFileSync(join(electronRoot, 'src/renderer/src/main.tsx'), 'utf8')

function sourceIndex(marker) {
  const index = mainSource.indexOf(marker)
  assert.notEqual(index, -1, `未找到启动编排锚点：${marker}`)
  return index
}

describe('renderer 渐进启动编排', () => {
  it('设备身份同步与首屏模块加载并行，但先于应用挂载完成', () => {
    const identityStart = sourceIndex('const deviceIdentityPromise =')
    const bootstrapStart = sourceIndex('async function bootstrap()')
    const identityAwait = sourceIndex('await deviceIdentityPromise')
    const appRender = sourceIndex('root.render(')

    assert.ok(identityStart < bootstrapStart)
    assert.ok(identityAwait < appRender)
  })

  it('AppLayout 预加载完成后再挂载应用，避免第二个全屏加载态', () => {
    const preloadAwait = sourceIndex("await timedImport('AppLayout'")
    const appRender = sourceIndex('root.render(')

    assert.ok(preloadAwait < appRender)
  })

  it('开发态后台运行时在应用挂载后初始化', () => {
    const appRender = sourceIndex('root.render(')
    const devRuntimeStart = sourceIndex('void initializeRuntimeModules().catch')

    assert.ok(appRender < devRuntimeStart)
  })
})

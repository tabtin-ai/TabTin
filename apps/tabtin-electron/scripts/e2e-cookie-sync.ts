/**
 * Wave 2b 任务 E · 真实 Electron session E2E 脚本。
 *
 * ## 为什么要这个脚本
 *
 * 反思 3（Wave 1.5 失败教训）说：**mock 通过不等于业务达成**。Wave 2b-E 的
 * CookieSyncService 单测里 mock 了 `session.fromPartition` 的 Map 实现，断言
 * "set/get 顺序正确"。但这类 mock 永远覆盖不到：
 *
 *   - 真实 Chromium `cookies.on('changed')` 的派发时序
 *   - 真实 `cookies.set/remove` 对 secure/sameSite/http-only 的校验
 *   - 跨 partition 隔离是否由真正的 Chromium session 保证
 *   - persist 模式下 partition key 是否被 Electron 正确解析
 *
 * 本脚本在**真实 Electron 主进程**里启动 CookieSyncService，配一个假的
 * `BrowserEnvironmentService`（不需要真后端），直接用 `session.fromPartition`
 * 写/删 cookie 并断言"同 env 内扩散、跨 env 隔离"。
 *
 * ## 场景（来自补丁 prompt）
 *
 * 1. env1 下 A/B/C 三个 Space，env2 下 D 一个 Space
 * 2. 在 A 的 partition（`persist:tabtin:env:space-A`）写 cookie
 * 3. 等 debounce → B/C partition 应该读到；env1 的 partition_key 也读到
 * 4. D（env2）读不到
 * 5. A 删 cookie → B/C 也被删
 *
 * ## 命名变更（Wave 3 收尾）
 *
 * Wave 1 之前 partition 用 `tabtin:crawlspace:*` 前缀（Crawlspace 隔离模型）。
 * Wave 1 把 BrowserEnvironment 退役回本地后，CookieSyncService 与 credential-vault
 * 白名单都只认 `tabtin:env:*`。Wave 3 同步把本脚本 fixture partition 改成新前缀，
 * 否则脚本会因 watcher 拒绝监听 legacy 前缀而静默 false-fail 被误读成产品 bug。
 *
 * ## 怎么跑
 *
 * ```bash
 * # 本地（有 display 或 xvfb）
 * bash apps/tabtin-electron/scripts/e2e-cookie-sync.sh
 *
 * # CI 无 display 时（Linux CI 环境）
 * xvfb-run -a bash apps/tabtin-electron/scripts/e2e-cookie-sync.sh
 * ```
 *
 * ## 环境要求
 *
 * - 已跑 `pnpm install`
 * - Linux 需要 `libgtk-3-0`、`libatk-1.0-0`、`libgbm1` 等 Electron 运行时库；
 *   缺失会报 `error while loading shared libraries`，属环境问题不是脚本 bug。
 *
 * ## 退出码
 *
 * - 0 = 全部断言通过
 * - 1 = 至少一条断言失败
 * - 2 = 脚本本身错误（Service 启动失败 / Electron 环境问题）
 */

import { app, session as electronSession } from 'electron'
import type { Session } from 'electron'

import {
  CookieSyncService,
  __resetCookieSyncServiceForTests,
} from '../src/main/browser-env/CookieSyncService'

// ── Fake BrowserEnvironmentService ─────────────────────────────

interface FakeEnv {
  id: string
  name: string
  partition_key: string
  is_default: boolean
}
interface FakeBinding {
  space_id: string
  environment_id: string
  is_explicit: boolean
}

class FakeBrowserEnvironmentService {
  private envs: FakeEnv[] = [
    { id: 'env1', name: 'env1', partition_key: 'tabtin:env:env1', is_default: true },
    { id: 'env2', name: 'env2', partition_key: 'tabtin:env:env2', is_default: false },
  ]
  private bindings: FakeBinding[] = [
    { space_id: 'space-A', environment_id: 'env1', is_explicit: true },
    { space_id: 'space-B', environment_id: 'env1', is_explicit: true },
    // is_explicit=false —— 验证 P0-1 "隐式 binding 也要监听"
    { space_id: 'space-C', environment_id: 'env1', is_explicit: false },
    { space_id: 'space-D', environment_id: 'env2', is_explicit: true },
  ]
  // Wave 2b 真·收尾补丁 P1-新-3：订阅 changed 事件的 handlers 列表。
  // 单测 / E2E 场景 5 用 updateBindings 模拟"用户在设置页改 Space↔env 绑定"。
  private changeHandlers: Array<(payload: { reason: string }) => void> = []

  listEnvironmentsSync() {
    return this.envs.slice()
  }

  listBindingsSync() {
    return this.bindings.slice()
  }

  getAllKnownSpaceEnvBindings() {
    return this.bindings.map((b) => ({
      spaceId: b.space_id,
      envId: b.environment_id,
      isExplicit: b.is_explicit,
    }))
  }

  onChanged(handler: (payload: { reason: string }) => void): () => void {
    this.changeHandlers.push(handler)
    return () => {
      this.changeHandlers = this.changeHandlers.filter((h) => h !== handler)
    }
  }

  /**
   * 测试专用：替换当前 bindings + 触发 change 事件（reason='bound'）。
   * 让 CookieSyncService 感知到环境切换并 rebuild partitionsByEnv。
   */
  updateBindings(newBindings: FakeBinding[], reason = 'bound') {
    this.bindings = newBindings.slice()
    for (const h of this.changeHandlers) {
      try {
        h({ reason })
      } catch (err) {
        console.warn('[FakeBrowserEnvironmentService] change handler threw', err)
      }
    }
  }
}

// ── 断言工具 ───────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  \u001b[32m\u2713\u001b[0m ${name}`)
    passed++
  } else {
    console.error(`  \u001b[31m\u2717\u001b[0m ${name}${detail ? ' — ' + detail : ''}`)
    failed++
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function fromPartition(partitionKey: string): Session {
  const prefixed = partitionKey.startsWith('persist:') ? partitionKey : `persist:${partitionKey}`
  return electronSession.fromPartition(prefixed)
}

async function writeCookie(
  partitionKey: string,
  cookie: {
    name: string
    value: string
    domain: string
    path?: string
    secure?: boolean
    sameSite?: 'lax' | 'strict' | 'no_restriction' | 'unspecified'
  },
): Promise<void> {
  const ses = fromPartition(partitionKey)
  const cleanDomain = cookie.domain.replace(/^\./, '')
  const url = `${cookie.secure ? 'https' : 'http'}://${cleanDomain}${cookie.path ?? '/'}`
  await ses.cookies.set({
    url,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? '/',
    secure: cookie.secure ?? false,
    sameSite: cookie.sameSite ?? 'lax',
  })
}

async function removeCookie(
  partitionKey: string,
  cookie: { name: string; domain: string },
): Promise<void> {
  const ses = fromPartition(partitionKey)
  const cleanDomain = cookie.domain.replace(/^\./, '')
  await ses.cookies.remove(`https://${cleanDomain}/`, cookie.name)
}

async function hasCookie(
  partitionKey: string,
  name: string,
  domain: string,
): Promise<boolean> {
  const ses = fromPartition(partitionKey)
  const list = await ses.cookies.get({ name, domain })
  return list.length > 0
}

// ── 主流程 ─────────────────────────────────────────────────────

app.disableHardwareAcceleration()

async function run(): Promise<number> {
  console.log('\u001b[33m[e2e-cookie-sync]\u001b[0m 启动…')
  __resetCookieSyncServiceForTests()

  const fakeService = new FakeBrowserEnvironmentService()
  const svc = new CookieSyncService({
    // 直接注入 fake，不经过 singleton
    service: fakeService as unknown as import('../src/main/browser-env/BrowserEnvironmentService').BrowserEnvironmentService,
    debounceMs: 100,
  })
  await svc.start()

  const stats = svc.getStats()
  console.log(
    `[e2e-cookie-sync] CookieSyncService 已启动：${stats.watchedPartitions} 个 partition 跨 ${stats.environments} 个 env`,
  )
  console.log('[e2e-cookie-sync] envMap:', JSON.stringify(stats.envMap))

  // 清理所有可能残留的 cookies（脚本重跑时）
  for (const p of [
    'tabtin:env:env1',
    'tabtin:env:env2',
    'tabtin:env:space-A',
    'tabtin:env:space-B',
    'tabtin:env:space-C',
    'tabtin:env:space-D',
  ]) {
    try {
      await removeCookie(p, { name: 'e2e_login', domain: '.github.com' })
    } catch {
      /* ignore */
    }
  }
  await delay(100)

  console.log('\n[e2e-cookie-sync] 场景 1：P0-1 验证 — 隐式 binding 的 Space 也被监听')
  // space-C 是 is_explicit=false 的隐式 binding——确认它的 legacy partition 在监听集里
  const env1Partitions = stats.envMap['env1'] ?? []
  assert(
    'env1 映射包含 space-A 的 legacy partition',
    env1Partitions.includes('tabtin:env:space-A'),
  )
  assert(
    'env1 映射包含 space-B 的 legacy partition',
    env1Partitions.includes('tabtin:env:space-B'),
  )
  assert(
    '【P0-1】env1 映射包含 space-C 的 legacy partition（隐式 binding）',
    env1Partitions.includes('tabtin:env:space-C'),
  )
  assert(
    'env1 映射包含 env partition_key',
    env1Partitions.includes('tabtin:env:env1'),
  )
  const env2Partitions = stats.envMap['env2'] ?? []
  assert(
    'env2 映射包含 space-D 的 legacy partition',
    env2Partitions.includes('tabtin:env:space-D'),
  )

  console.log('\n[e2e-cookie-sync] 场景 2：A 写 cookie → B/C 同步、D 隔离')
  await writeCookie('tabtin:env:space-A', {
    name: 'e2e_login',
    value: 'token_abc',
    domain: '.github.com',
    path: '/',
    secure: true,
    sameSite: 'lax',
  })

  // 等 debounce 窗口 + 缓冲
  await delay(400)

  assert(
    'B 读到 cookie（同 env1 扩散）',
    await hasCookie('tabtin:env:space-B', 'e2e_login', '.github.com'),
  )
  assert(
    '【P0-1】C 读到 cookie（隐式 binding 的 Space 也收到同步）',
    await hasCookie('tabtin:env:space-C', 'e2e_login', '.github.com'),
  )
  assert(
    'env1 partition_key 读到 cookie',
    await hasCookie('tabtin:env:env1', 'e2e_login', '.github.com'),
  )
  assert(
    'D 读不到 cookie（env2 隔离）',
    !(await hasCookie('tabtin:env:space-D', 'e2e_login', '.github.com')),
  )
  assert(
    'env2 partition_key 读不到 cookie',
    !(await hasCookie('tabtin:env:env2', 'e2e_login', '.github.com')),
  )

  console.log('\n[e2e-cookie-sync] 场景 3：A 删 cookie → B/C 同步删除')
  await removeCookie('tabtin:env:space-A', { name: 'e2e_login', domain: '.github.com' })
  await delay(400)

  assert(
    'A 删除后 B 也被删',
    !(await hasCookie('tabtin:env:space-B', 'e2e_login', '.github.com')),
  )
  assert(
    'A 删除后 C 也被删',
    !(await hasCookie('tabtin:env:space-C', 'e2e_login', '.github.com')),
  )

  console.log('\n[e2e-cookie-sync] 场景 4：防环 — A 写入不回流触发 A 再次被写')
  // 监听 A partition 的 changed 事件，记录是否有"非自己写入"的事件
  const aSession = fromPartition('tabtin:env:space-A')
  const aEvents: Array<{ name: string; cause: string; removed: boolean }> = []
  const handler = (
    _e: unknown,
    c: Electron.Cookie,
    cause: string,
    removed: boolean,
  ) => {
    aEvents.push({ name: c.name, cause, removed })
  }
  aSession.cookies.on('changed', handler)

  await writeCookie('tabtin:env:space-A', {
    name: 'loop_probe',
    value: 'v',
    domain: '.example.org',
    path: '/',
    secure: false,
    sameSite: 'lax',
  })
  await delay(400)

  aSession.cookies.off('changed', handler)
  const loopProbes = aEvents.filter((e) => e.name === 'loop_probe')
  assert(
    `A 的 changed 只看到一次自己的写入（实际=${loopProbes.length}）`,
    loopProbes.length === 1,
    JSON.stringify(loopProbes),
  )
  assert(
    'B 收到 loop_probe（证明同步确实发生过）',
    await hasCookie('tabtin:env:space-B', 'loop_probe', '.example.org'),
  )

  // 清理
  await removeCookie('tabtin:env:space-A', { name: 'loop_probe', domain: '.example.org' })
  await delay(200)

  // ── 场景 5：Wave 2b 真·收尾补丁 P1-新-3 ──────────────────────────
  //
  // 模拟用户在设置页把 space-A 从 env1 切到 env2：
  //   1. 清干净所有 partition 的测试 cookie
  //   2. updateBindings → CookieSyncService 通过 onChanged rebuild
  //   3. A 写新 cookie → env1 的 B/C 应**不再**收到；env2 的 D 应收到
  //
  // 覆盖的风险：rebuild 后如果 watch 入口没被正确替换、或回环检测不重置，
  // 就会出现"cookie 还在往旧 env 扩散"或"cookie 完全不扩散"两种 bug。
  console.log('\n[e2e-cookie-sync] 场景 5：updateBindings 切换绑定 → CookieSync rebuild 生效')

  // 清掉前面测试可能残留
  for (const p of [
    'tabtin:env:env1',
    'tabtin:env:env2',
    'tabtin:env:space-A',
    'tabtin:env:space-B',
    'tabtin:env:space-C',
    'tabtin:env:space-D',
  ]) {
    try {
      await removeCookie(p, { name: 'scenario5_cookie', domain: '.example.net' })
    } catch {
      /* ignore */
    }
  }
  await delay(150)

  // 把 space-A 切到 env2
  fakeService.updateBindings([
    { space_id: 'space-A', environment_id: 'env2', is_explicit: true }, // 变了
    { space_id: 'space-B', environment_id: 'env1', is_explicit: true },
    { space_id: 'space-C', environment_id: 'env1', is_explicit: false },
    { space_id: 'space-D', environment_id: 'env2', is_explicit: true },
  ])

  // 给 rebuild 一个微秒级 yield（CookieSyncService 的 onChanged 是同步的，
  // 但 session.fromPartition 内部会创建 session 对象）
  await delay(100)

  const statsAfter = svc.getStats()
  const env1AfterSwitch = statsAfter.envMap['env1'] ?? []
  const env2AfterSwitch = statsAfter.envMap['env2'] ?? []
  assert(
    '切换后 env1 不再包含 space-A 的 legacy partition',
    !env1AfterSwitch.includes('tabtin:env:space-A'),
  )
  assert(
    '切换后 env2 包含 space-A 的 legacy partition',
    env2AfterSwitch.includes('tabtin:env:space-A'),
  )

  // 在 A 写新 cookie
  await writeCookie('tabtin:env:space-A', {
    name: 'scenario5_cookie',
    value: 'new_env_v',
    domain: '.example.net',
    path: '/',
    secure: false,
    sameSite: 'lax',
  })
  await delay(400)

  assert(
    '切换后 D 读到 cookie（env2 同步）',
    await hasCookie('tabtin:env:space-D', 'scenario5_cookie', '.example.net'),
  )
  assert(
    '切换后 env2 partition_key 读到 cookie',
    await hasCookie('tabtin:env:env2', 'scenario5_cookie', '.example.net'),
  )
  assert(
    '【P1-新-3】切换后 B 读不到 cookie（env1 不再扩散给 space-A）',
    !(await hasCookie('tabtin:env:space-B', 'scenario5_cookie', '.example.net')),
  )
  assert(
    '【P1-新-3】切换后 C 读不到 cookie（env1 不再扩散给 space-A）',
    !(await hasCookie('tabtin:env:space-C', 'scenario5_cookie', '.example.net')),
  )
  assert(
    '【P1-新-3】切换后 env1 partition_key 读不到 cookie',
    !(await hasCookie('tabtin:env:env1', 'scenario5_cookie', '.example.net')),
  )

  // 清理
  for (const p of [
    'tabtin:env:env1',
    'tabtin:env:env2',
    'tabtin:env:space-A',
    'tabtin:env:space-B',
    'tabtin:env:space-C',
    'tabtin:env:space-D',
  ]) {
    try {
      await removeCookie(p, { name: 'scenario5_cookie', domain: '.example.net' })
    } catch {
      /* ignore */
    }
  }
  await delay(150)

  svc.stop()

  console.log(`\n[e2e-cookie-sync] 结果：\u001b[32m${passed} 通过\u001b[0m / \u001b[31m${failed} 失败\u001b[0m`)
  return failed === 0 ? 0 : 1
}

app
  .whenReady()
  .then(() => run())
  .then((code) => app.exit(code))
  .catch((err) => {
    console.error('[e2e-cookie-sync] 脚本崩溃:', err)
    app.exit(2)
  })

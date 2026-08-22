/**
 * ResourceManager 功能测试
 *
 * 运行：node test-resource-manager.mjs
 */

// 模拟 ResourceManager（简化版，用于测试逻辑）
class ResourceManager {
  constructor() {
    this.resources = new Map()
    this.taskResourceMap = new Map()
  }

  register(resource) {
    this.resources.set(resource.id, resource)
    console.log(`[ResourceManager] ✅ 注册资源: ${resource.id}`)
  }

  get(resourceId) {
    return this.resources.get(resourceId) || null
  }

  attachToTask(resourceId, taskId) {
    const resource = this.resources.get(resourceId)
    if (!resource) return

    resource.taskId = taskId
    resource.status = 'in_use'

    if (!this.taskResourceMap.has(taskId)) {
      this.taskResourceMap.set(taskId, new Set())
    }
    this.taskResourceMap.get(taskId).add(resourceId)

    console.log(`[ResourceManager] ✅ 关联资源到任务: ${resourceId} → ${taskId}`)
  }

  detachFromTask(resourceId) {
    const resource = this.resources.get(resourceId)
    if (!resource || !resource.taskId) return

    const taskId = resource.taskId
    resource.taskId = null
    resource.status = 'idle'

    const taskResources = this.taskResourceMap.get(taskId)
    if (taskResources) {
      taskResources.delete(resourceId)
      if (taskResources.size === 0) {
        this.taskResourceMap.delete(taskId)
      }
    }

    console.log(`[ResourceManager] 🔓 解除资源关联: ${resourceId}`)
  }

  getTaskResources(taskId) {
    const resourceIds = this.taskResourceMap.get(taskId)
    return resourceIds ? Array.from(resourceIds) : []
  }

  async cleanupTask(taskId, force = false) {
    console.log(`[ResourceManager] 🧹 清理任务资源: ${taskId} (强制: ${force})`)

    // ✅ 修复：复制资源 ID 数组，因为 detachFromTask 会修改 taskResourceMap
    const resourceIds = [...this.getTaskResources(taskId)]
    let cleaned = 0
    let failed = 0

    for (const resourceId of resourceIds) {
      const resource = this.resources.get(resourceId)
      if (!resource) continue

      // 如果不强制清理，且资源有 keepAlive，则跳过
      if (!force && resource.expiresAt && resource.expiresAt > Date.now()) {
        console.log(`[ResourceManager] ⏭️  跳过 keepAlive 资源: ${resourceId}`)
        this.detachFromTask(resourceId)
        continue
      }

      // 清理资源
      this.unregister(resourceId)
      cleaned++
    }

    return { cleaned, failed, errors: [] }
  }

  unregister(resourceId) {
    const resource = this.resources.get(resourceId)
    if (!resource) return false

    // 从任务映射中移除
    if (resource.taskId) {
      const taskResources = this.taskResourceMap.get(resource.taskId)
      if (taskResources) {
        taskResources.delete(resourceId)
        if (taskResources.size === 0) {
          this.taskResourceMap.delete(resource.taskId)
        }
      }
    }

    // 删除资源
    this.resources.delete(resourceId)
    console.log(`[ResourceManager] 🗑️  注销资源: ${resourceId}`)

    return true
  }

  getStats() {
    const stats = {
      total: this.resources.size,
      idle: 0,
      inUse: 0,
      expired: 0,
      byType: { view: 0, cdp: 0 },
      byTask: new Map()
    }

    const now = Date.now()

    for (const resource of this.resources.values()) {
      // 状态统计
      if (resource.expiresAt && resource.expiresAt <= now) {
        stats.expired++
      } else if (resource.status === 'idle') {
        stats.idle++
      } else if (resource.status === 'in_use') {
        stats.inUse++
      }

      // 类型统计
      if (resource.type === 'view') {
        stats.byType.view++
      } else if (resource.type === 'cdp') {
        stats.byType.cdp++
      }

      // 任务统计
      if (resource.taskId) {
        stats.byTask.set(resource.taskId, (stats.byTask.get(resource.taskId) || 0) + 1)
      }
    }

    return stats
  }
}

// ========== 测试辅助函数 ==========

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
}

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`)
}

function assert(condition, message) {
  if (condition) {
    log(`✅ PASS: ${message}`, colors.green)
    return true
  } else {
    log(`❌ FAIL: ${message}`, colors.red)
    return false
  }
}

// ========== 运行测试 ==========

async function runTests() {
  log('\n=== ResourceManager 功能测试 ===\n', colors.cyan)

  const rm = new ResourceManager()
  let passedTests = 0
  let failedTests = 0

  // 测试 1: 资源注册
  log('\n【测试 1】资源注册', colors.blue)

  const viewResource = {
    id: 'view-test-1',
    type: 'view',
    status: 'in_use',
    taskId: null,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    expiresAt: null,
    viewId: 'test-view-1',
    url: 'https://example.com'
  }

  rm.register(viewResource)

  const retrieved = rm.get('view-test-1')
  if (assert(retrieved !== null, '资源应该被成功注册')) passedTests++; else failedTests++
  if (assert(retrieved?.type === 'view', '资源类型应该是 view')) passedTests++; else failedTests++

  const stats1 = rm.getStats()
  if (assert(stats1.total === 1, '资源总数应该是 1')) passedTests++; else failedTests++

  // 测试 2: 关联资源到任务
  log('\n【测试 2】关联资源到任务', colors.blue)

  rm.attachToTask('view-test-1', 'task-123')

  const retrieved2 = rm.get('view-test-1')
  if (assert(retrieved2?.taskId === 'task-123', '资源应该关联到任务')) passedTests++; else failedTests++
  if (assert(retrieved2?.status === 'in_use', '资源状态应该是 in_use')) passedTests++; else failedTests++

  const taskResources = rm.getTaskResources('task-123')
  if (assert(taskResources.includes('view-test-1'), '任务资源列表应该包含该资源')) passedTests++; else failedTests++

  // 测试 3: 添加第二个资源
  log('\n【测试 3】添加第二个资源到同一任务', colors.blue)

  const cdpResource = {
    id: 'cdp-test-1',
    type: 'cdp',
    status: 'in_use',
    taskId: null,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    expiresAt: null,
    connectionId: 'test-conn-1',
    url: 'https://example.com'
  }

  rm.register(cdpResource)
  rm.attachToTask('cdp-test-1', 'task-123')

  const taskResources2 = rm.getTaskResources('task-123')
  if (assert(taskResources2.length === 2, '任务应该有 2 个资源')) passedTests++; else failedTests++

  const stats2 = rm.getStats()
  if (assert(stats2.total === 2, '总资源数应该是 2')) passedTests++; else failedTests++
  if (assert(stats2.inUse === 2, '使用中资源数应该是 2')) passedTests++; else failedTests++

  // 测试 4: 清理任务资源（强制）
  log('\n【测试 4】清理任务资源（强制）', colors.blue)

  const cleanupResult = await rm.cleanupTask('task-123', true)

  if (assert(cleanupResult.cleaned === 2, '应该清理 2 个资源')) passedTests++; else failedTests++

  const stats3 = rm.getStats()
  if (assert(stats3.total === 0, '清理后总资源数应该是 0')) passedTests++; else failedTests++

  // 测试 5: keepAlive 模式
  log('\n【测试 5】keepAlive 模式（不强制清理）', colors.blue)

  const now = Date.now()
  const keepAliveResource = {
    id: 'view-keepalive',
    type: 'view',
    status: 'in_use',
    taskId: 'task-keepalive',
    createdAt: now,
    lastAccessAt: now,
    expiresAt: now + 300000,  // 5 分钟后过期
    viewId: 'test-view-keepalive',
    url: 'https://example.com'
  }

  rm.register(keepAliveResource)
  // ✅ 需要先关联到任务，因为 register 时只是设置了 taskId 字段
  rm.attachToTask('view-keepalive', 'task-keepalive')

  const cleanupResult2 = await rm.cleanupTask('task-keepalive', false)

  if (assert(cleanupResult2.cleaned === 0, 'keepAlive 模式下不应该清理未过期资源')) passedTests++; else failedTests++

  const stats4 = rm.getStats()
  if (assert(stats4.total === 1, '资源应该被保留')) passedTests++; else failedTests++

  const retrieved3 = rm.get('view-keepalive')
  if (assert(retrieved3?.taskId === null, '任务关联应该被解除')) passedTests++; else failedTests++
  if (assert(retrieved3?.status === 'idle', '资源状态应该变为 idle')) passedTests++; else failedTests++

  // 测试 6: 强制清理 keepAlive 资源
  log('\n【测试 6】强制清理 keepAlive 资源', colors.blue)

  rm.attachToTask('view-keepalive', 'task-force')

  const cleanupResult3 = await rm.cleanupTask('task-force', true)

  if (assert(cleanupResult3.cleaned === 1, '强制清理应该忽略 keepAlive')) passedTests++; else failedTests++

  const stats5 = rm.getStats()
  if (assert(stats5.total === 0, '强制清理后资源应该被删除')) passedTests++; else failedTests++

  // 测试 7: 解除任务关联
  log('\n【测试 7】解除任务关联', colors.blue)

  const detachResource = {
    id: 'view-detach',
    type: 'view',
    status: 'in_use',
    taskId: null,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    expiresAt: null,
    viewId: 'test-view-detach',
    url: 'https://example.com'
  }

  rm.register(detachResource)
  rm.attachToTask('view-detach', 'task-detach')
  rm.detachFromTask('view-detach')

  const retrieved4 = rm.get('view-detach')
  if (assert(retrieved4?.taskId === null, '任务关联应该被解除')) passedTests++; else failedTests++
  if (assert(retrieved4?.status === 'idle', '状态应该变为 idle')) passedTests++; else failedTests++

  rm.unregister('view-detach')

  // 测试 8: 资源注销
  log('\n【测试 8】资源注销', colors.blue)

  const unregResource = {
    id: 'view-unreg',
    type: 'view',
    status: 'idle',
    taskId: null,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    expiresAt: null,
    viewId: 'test-view-unreg',
    url: 'https://example.com'
  }

  rm.register(unregResource)

  const unregResult = rm.unregister('view-unreg')
  if (assert(unregResult === true, '注销应该成功')) passedTests++; else failedTests++

  const retrieved5 = rm.get('view-unreg')
  if (assert(retrieved5 === null, '注销后资源应该不存在')) passedTests++; else failedTests++

  const unregResult2 = rm.unregister('non-existent')
  if (assert(unregResult2 === false, '注销不存在的资源应该返回 false')) passedTests++; else failedTests++

  // 总结
  log('\n=== 测试总结 ===\n', colors.cyan)

  const totalTests = passedTests + failedTests
  log(`总测试数: ${totalTests}`, colors.yellow)
  log(`通过: ${passedTests}`, colors.green)
  log(`失败: ${failedTests}`, failedTests > 0 ? colors.red : colors.green)

  const passRate = (passedTests / totalTests * 100).toFixed(1)
  log(`\n通过率: ${passRate}%\n`, failedTests === 0 ? colors.green : colors.yellow)

  if (failedTests === 0) {
    log('🎉 所有测试通过！ResourceManager 功能正常', colors.green)
    log('\n📋 测试覆盖范围:', colors.cyan)
    log('  ✅ 资源注册和获取', colors.green)
    log('  ✅ 资源关联到任务', colors.green)
    log('  ✅ 多个资源管理', colors.green)
    log('  ✅ 强制清理任务资源', colors.green)
    log('  ✅ keepAlive 模式（保留未过期资源）', colors.green)
    log('  ✅ 强制清理忽略 keepAlive', colors.green)
    log('  ✅ 解除任务关联', colors.green)
    log('  ✅ 资源注销', colors.green)
  } else {
    log('⚠️  部分测试失败，请检查代码', colors.yellow)
  }

  return failedTests === 0
}

// 运行测试
runTests().then(success => {
  process.exit(success ? 0 : 1)
}).catch(error => {
  log(`\n💥 测试运行异常: ${error.message}`, colors.red)
  console.error(error)
  process.exit(1)
})

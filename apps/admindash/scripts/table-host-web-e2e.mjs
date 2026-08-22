#!/usr/bin/env node

import assert from 'node:assert/strict'

const REQUIRED_ENV_KEYS = [
  'TABLE_HOST_E2E_BASE_URL',
  'TABLE_HOST_E2E_API_BASE_URL',
  'TABLE_HOST_E2E_TOKEN',
  'TABLE_HOST_E2E_WORKSPACE_ID',
  'TABLE_HOST_E2E_AGENT_SPACE_ID',
]

const ensureRequiredEnv = () => {
  const missing = REQUIRED_ENV_KEYS.filter((key) => !process.env[key])
  if (missing.length > 0) {
    throw new Error(
      `缺少 E2E 环境变量: ${missing.join(', ')}\n示例：TABLE_HOST_E2E_BASE_URL=http://127.0.0.1:5173 TABLE_HOST_E2E_API_BASE_URL=http://127.0.0.1:6060/api ...`
    )
  }
}

const normalizeBaseUrl = (value) => value.replace(/\/$/, '')

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })

  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }

  return { response, body }
}

const assertSuccessEnvelope = (body, fallbackMessage) => {
  assert.ok(body && typeof body === 'object', fallbackMessage)
  assert.equal(body.success, true, body.message || fallbackMessage)
}

const main = async () => {
  ensureRequiredEnv()

  const webBase = normalizeBaseUrl(process.env.TABLE_HOST_E2E_BASE_URL)
  const apiBase = normalizeBaseUrl(process.env.TABLE_HOST_E2E_API_BASE_URL)
  const token = process.env.TABLE_HOST_E2E_TOKEN
  const workspaceId = process.env.TABLE_HOST_E2E_WORKSPACE_ID
  const agentSpaceId = process.env.TABLE_HOST_E2E_AGENT_SPACE_ID

  const routeUrl = `${webBase}/table-host-web/${encodeURIComponent(workspaceId)}/${encodeURIComponent(agentSpaceId)}`
  console.log('[e2e] 1/5 检查深链路由:', routeUrl)
  const routeResponse = await fetch(routeUrl, { method: 'GET' })
  assert.equal(routeResponse.status, 200, `深链路由返回异常: ${routeResponse.status}`)
  const routeHtml = await routeResponse.text()
  assert.ok(routeHtml.includes('<div id="root"></div>'), '深链页面缺少 root 挂载点')

  const authHeaders = {
    Authorization: `Bearer ${token}`,
  }

  const tableName = `e2e_table_${Date.now()}`
  let createdTableId = null
  try {
    const listByAgentSpaceUrl = `${apiBase}/tabdata/workspaces/${workspaceId}/agent-spaces/${agentSpaceId}/tables`

    console.log('[e2e] 2/5 创建表格并验证列表回刷')
    const createResult = await requestJson(listByAgentSpaceUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: tableName,
        description: 'e2e regression',
      }),
    })
    assert.equal(createResult.response.status, 201, `创建表格失败: ${createResult.response.status}`)
    assertSuccessEnvelope(createResult.body, '创建表格响应不符合预期')
    createdTableId = createResult.body?.data?.id
    assert.ok(createdTableId, '创建表格后未返回 table id')

    const listResult = await requestJson(listByAgentSpaceUrl, {
      method: 'GET',
      headers: authHeaders,
    })
    assert.equal(listResult.response.status, 200, `读取表格列表失败: ${listResult.response.status}`)
    assertSuccessEnvelope(listResult.body, '读取表格列表响应不符合预期')
    const listedTables = listResult.body?.data?.tables ?? []
    assert.ok(
      listedTables.some((item) => item.id === createdTableId),
      '新建表格未出现在项目表格列表中'
    )

    console.log('[e2e] 3/5 更新表格并验证详情')
    const updatedName = `${tableName}_updated`
    const updateResult = await requestJson(`${apiBase}/tabdata/tables/${createdTableId}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ name: updatedName }),
    })
    assert.equal(updateResult.response.status, 200, `更新表格失败: ${updateResult.response.status}`)
    assertSuccessEnvelope(updateResult.body, '更新表格响应不符合预期')

    const detailResult = await requestJson(`${apiBase}/tabdata/tables/${createdTableId}`, {
      method: 'GET',
      headers: authHeaders,
    })
    assert.equal(
      detailResult.response.status,
      200,
      `读取表格详情失败: ${detailResult.response.status}`
    )
    assertSuccessEnvelope(detailResult.body, '读取表格详情响应不符合预期')
    assert.equal(detailResult.body?.data?.name, updatedName, '表格名称未按预期更新')

    console.log('[e2e] 4/5 删除表格并验证已移除')
    const deletedTableId = createdTableId
    const deleteResult = await requestJson(`${apiBase}/tabdata/tables/${createdTableId}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
    assert.equal(deleteResult.response.status, 200, `删除表格失败: ${deleteResult.response.status}`)
    assertSuccessEnvelope(deleteResult.body, '删除表格响应不符合预期')
    createdTableId = null

    const verifyListResult = await requestJson(listByAgentSpaceUrl, {
      method: 'GET',
      headers: authHeaders,
    })
    assert.equal(
      verifyListResult.response.status,
      200,
      `删除后读取列表失败: ${verifyListResult.response.status}`
    )
    assertSuccessEnvelope(verifyListResult.body, '删除后读取列表响应不符合预期')
    const tablesAfterDelete = verifyListResult.body?.data?.tables ?? []
    assert.ok(
      !tablesAfterDelete.some((item) => item.id === deletedTableId),
      '删除后列表仍包含目标表格'
    )
  } finally {
    if (createdTableId) {
      await requestJson(`${apiBase}/tabdata/tables/${createdTableId}`, {
        method: 'DELETE',
        headers: authHeaders,
      }).catch(() => {})
    }
  }

  console.log('[e2e] 5/5 完成: 深链路由 + 真实 API CRUD 回归通过')
}

main().catch((error) => {
  console.error('[e2e] 失败:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

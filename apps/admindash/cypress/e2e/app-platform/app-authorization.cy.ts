describe('用户应用授权管理页', () => {
  beforeEach(() => {
    cy.intercept('GET', '/api/auth/admin/app-authorization*', {
      statusCode: 200,
      body: {
        success: true,
        data: {
          items: [
            {
              id: 'auth-1',
              space_id: 'space-1',
              space_name: 'DevOps Space',
              user_id: 'user-1',
              allow_all: false,
              tools: ['demo_action_send', 'demo_action_create'],
              apps: ['demo-app'],
              disabled_apps: [],
              created_at: '2026-04-01T00:00:00Z',
              updated_at: '2026-04-18T10:00:00Z',
            },
            {
              id: 'auth-2',
              space_id: 'space-2',
              space_name: 'Marketing Space',
              user_id: 'user-2',
              allow_all: true,
              tools: [],
              apps: [],
              disabled_apps: [],
              created_at: '2026-03-15T00:00:00Z',
              updated_at: '2026-04-10T10:00:00Z',
            },
          ],
          total: 2,
          pagination: { page: 1, page_size: 20, total_pages: 1 },
        },
      },
    }).as('listAuth')

    cy.loginAsAdmin()
    cy.visit('/app-authorization')
    cy.wait('@listAuth')
  })

  it('显示授权列表', () => {
    cy.contains('用户应用授权管理').should('be.visible')
    cy.contains('DevOps Space').should('be.visible')
    cy.contains('Marketing Space').should('be.visible')
  })

  it('显示授权模式标记', () => {
    cy.contains('全部允许').should('be.visible')
    cy.contains('部分限制').should('be.visible')
  })

  it('显示工具和应用列表', () => {
    cy.contains('demo_action_send').should('be.visible')
    cy.contains('demo-app').should('be.visible')
  })

  it('打开编辑弹窗', () => {
    cy.get('button[title="编辑"]').first().click()
    cy.contains('编辑授权').should('be.visible')
    cy.contains('DevOps Space').should('be.visible')
  })

  it('编辑授权并保存', () => {
    cy.intercept('POST', '/api/auth/admin/app-authorization/auth-1/update', {
      statusCode: 200,
      body: {
        success: true,
        data: { id: 'auth-1', space_id: 'space-1', user_id: 'user-1', allow_all: true, tools: [], apps: [] },
      },
    }).as('updateAuth')

    cy.get('button[title="编辑"]').first().click()
    cy.get('input[type="checkbox"]').check()
    cy.contains('保存').click()
    cy.wait('@updateAuth')
  })

  it('按 Space ID 过滤', () => {
    cy.get('input[placeholder*="Space ID"]').type('space-1')
    cy.wait('@listAuth')
  })
})

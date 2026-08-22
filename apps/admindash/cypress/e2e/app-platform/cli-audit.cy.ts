describe('CLI 审计查看页', () => {
  beforeEach(() => {
    cy.intercept('GET', '/api/auth/admin/cli-audit*', {
      statusCode: 200,
      body: {
        success: true,
        data: {
          items: [
            {
              id: 'evt-1',
              organization_id: 'wt-1',
              thread_id: 'thread-1',
              agent_id: 'agent-1',
              user_id: 'user-1',
              binary: 'tabtin',
              inner_binary: 'demo-cli',
              domain: 'im',
              verb: 'send',
              risk_level: 'review',
              rule_decision: 'allow',
              hitl_required: true,
              hitl_user_decision: 'allow',
              exit_code: 0,
              bypass: false,
              created_at: '2026-04-18T10:00:00Z',
              executed_at: '2026-04-18T10:00:01Z',
              finished_at: '2026-04-18T10:00:02Z',
            },
            {
              id: 'evt-2',
              organization_id: 'wt-1',
              thread_id: null,
              agent_id: null,
              user_id: 'user-1',
              binary: 'tabtin',
              inner_binary: null,
              domain: 'table',
              verb: 'query',
              risk_level: 'safe',
              rule_decision: 'allow',
              hitl_required: false,
              hitl_user_decision: null,
              exit_code: 0,
              bypass: false,
              created_at: '2026-04-18T09:30:00Z',
              executed_at: null,
              finished_at: null,
            },
          ],
          total: 2,
          pagination: { page: 1, page_size: 50, total_pages: 1 },
        },
      },
    }).as('listAudit')

    cy.loginAsAdmin()
    cy.visit('/cli-audit')
    cy.wait('@listAudit')
  })

  it('显示审计事件列表', () => {
    cy.contains('CLI 审计查看').should('be.visible')
    cy.contains('tabtin').should('be.visible')
    cy.contains('im').should('be.visible')
    cy.contains('send').should('be.visible')
  })

  it('显示风险级别标记', () => {
    cy.contains('review').should('be.visible')
    cy.contains('safe').should('be.visible')
  })

  it('显示 HITL 决策', () => {
    cy.contains('allow').should('be.visible')
  })

  it('按 binary 过滤', () => {
    cy.get('input[placeholder="binary"]').type('tabtin')
    cy.wait('@listAudit')
  })

  it('按风险级别过滤', () => {
    cy.get('select').first().select('review')
    cy.wait('@listAudit')
  })

  it('按 HITL 决策过滤', () => {
    cy.get('select').last().select('allow')
    cy.wait('@listAudit')
  })

  it('CSV 导出按钮可见', () => {
    cy.contains('导出 CSV').should('be.visible')
  })

  it('按 domain 过滤', () => {
    cy.get('input[placeholder="domain"]').type('im')
    cy.wait('@listAudit')
  })
})

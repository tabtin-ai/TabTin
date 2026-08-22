describe('App 安装管理页', () => {
  beforeEach(() => {
    cy.intercept('GET', '/api/auth/admin/app-installs*', {
      statusCode: 200,
      body: {
        success: true,
        data: {
          items: [
            {
              id: 'inst-1',
              organization_id: 'wt-1',
              app_id: 'demo-app',
              app_source: 'marketplace',
              installed_by: null,
              created_at: '2026-04-01T00:00:00Z',
              updated_at: '2026-04-01T00:00:00Z',
              device_snapshots: [
                {
                  id: 'snap-1',
                  device_id: 'dev-1',
                  device_name: 'MacBook Pro',
                  version: '1.0.0',
                  install_status: 'installed',
                  last_seen_at: '2026-04-18T10:00:00Z',
                  extra: {},
                },
              ],
              device_count: 1,
            },
            {
              id: 'inst-2',
              organization_id: 'wt-1',
              app_id: 'tabdata',
              app_source: 'core',
              installed_by: null,
              created_at: '2026-03-01T00:00:00Z',
              updated_at: '2026-03-01T00:00:00Z',
              device_snapshots: [],
              device_count: 0,
            },
          ],
          total: 2,
          pagination: { page: 1, page_size: 20, total_pages: 1 },
          summary: { total_installs: 2, core_count: 1, marketplace_count: 1 },
        },
      },
    }).as('listInstalls')

    cy.loginAsAdmin()
    cy.visit('/app-installs')
    cy.wait('@listInstalls')
  })

  it('显示 App 安装列表', () => {
    cy.contains('App 安装管理').should('be.visible')
    cy.contains('demo-app').should('be.visible')
    cy.contains('tabdata').should('be.visible')
  })

  it('显示汇总统计', () => {
    cy.contains('全部应用').should('be.visible')
    cy.contains('2').should('be.visible')
    cy.contains('核心应用').should('be.visible')
    cy.contains('市场应用').should('be.visible')
  })

  it('展开 device 详情', () => {
    cy.contains('demo-app').click()
    cy.contains('MacBook Pro').should('be.visible')
    cy.contains('1.0.0').should('be.visible')
    cy.contains('installed').should('be.visible')
  })

  it('按 App ID 过滤', () => {
    cy.get('input[placeholder*="App ID"]').type('demo-app')
    cy.wait('@listInstalls')
  })
})

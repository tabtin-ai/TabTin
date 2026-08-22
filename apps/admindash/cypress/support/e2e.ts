Cypress.Commands.add('loginAsAdmin', () => {
  cy.window().then((win) => {
    win.localStorage.setItem('access_token', 'test-admin-token')
    win.localStorage.setItem('refresh_token', 'test-refresh-token')
  })
})

declare global {
  namespace Cypress {
    interface Chainable {
      loginAsAdmin(): Chainable<void>
    }
  }
}

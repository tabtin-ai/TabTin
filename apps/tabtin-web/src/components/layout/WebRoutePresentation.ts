export type WebShell = 'full' | 'embedded'
export type WebClient = 'browser' | 'ios' | 'android'
export type WebHostTheme = 'light' | 'dark'

export interface WebRoutePresentation {
  shell: WebShell
  client: WebClient
  isEmbedded: boolean
  hostTheme: WebHostTheme | null
}

export function parseWebPresentation(search: string): WebRoutePresentation {
  const params = new URLSearchParams(search)
  const shell: WebShell = params.get('shell') === 'embedded' ? 'embedded' : 'full'
  const clientParam = params.get('client')
  const client: WebClient =
    clientParam === 'ios' || clientParam === 'android' ? clientParam : 'browser'
  const themeParam = params.get('theme')
  const hostTheme: WebHostTheme | null =
    shell === 'embedded' && (themeParam === 'light' || themeParam === 'dark')
      ? themeParam
      : null

  return { shell, client, isEmbedded: shell === 'embedded', hostTheme }
}

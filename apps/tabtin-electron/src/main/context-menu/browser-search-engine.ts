const DEFAULT_TEMPLATE = 'https://www.google.com/search?q=%s'

let currentTemplate = DEFAULT_TEMPLATE

export function setSearchEngineTemplate(template: string): void {
  if (template && template.includes('%s')) {
    currentTemplate = template
  }
}

export function buildSearchUrl(query: string): string {
  return currentTemplate.replace('%s', encodeURIComponent(query))
}

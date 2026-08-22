/**
 * Shared file-extension-to-language mapping for code display.
 */

export const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', swift: 'swift', c: 'c', cpp: 'c++', h: 'c',
  cs: 'c#', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', html: 'html', css: 'css', scss: 'scss', less: 'less',
  json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', md: 'markdown',
  toml: 'toml', ini: 'ini', env: 'env', dockerfile: 'dockerfile',
  vue: 'vue', svelte: 'svelte',
}

export function detectLanguage(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase()
  if (!ext) return undefined
  return EXT_LANG_MAP[ext]
}

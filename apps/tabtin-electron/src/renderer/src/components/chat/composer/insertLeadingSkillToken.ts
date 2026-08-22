import type {
  SkillSlashCommandOption,
  SlashCommandOption,
} from '../skill/skillSlashCommand'

const LEADING_TOKEN_RE = /^\s*\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+|$)/

export function insertLeadingSkillToken(
  input: string,
  selected: SkillSlashCommandOption,
  knownOptions: SlashCommandOption[],
): { value: string; cursor: number } {
  const leading = input.match(LEADING_TOKEN_RE)
  const isKnownLeadingToken = Boolean(
    leading
    && knownOptions.some(option => option.slug.toLowerCase() === leading[1].toLowerCase()),
  )
  const rest = isKnownLeadingToken && leading
    ? input.slice(leading[0].length).trimStart()
    : input.trimStart()
  const value = rest ? `${selected.token} ${rest}` : `${selected.token} `
  return { value, cursor: value.length }
}

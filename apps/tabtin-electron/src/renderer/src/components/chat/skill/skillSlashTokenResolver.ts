/**
 * Skill slash 命令 token 去重与消歧（从 buildSkillSlashCommandOptions 提取）。
 */

export function pickUniqueSlashToken(
  candidateTokens: string[],
  usedTokens: Set<string>,
  fallbackBaseSlug: string,
): string {
  const tokens = [...candidateTokens]
  let fallbackIndex = 2
  while (tokens.every(token => usedTokens.has(token.toLowerCase()))) {
    const fallbackToken = `/${fallbackBaseSlug}-${fallbackIndex}`
    tokens.push(fallbackToken)
    fallbackIndex += 1
  }
  return tokens.find(token => !usedTokens.has(token.toLowerCase())) ?? tokens[0] ?? `/${fallbackBaseSlug}`
}

export function resolveDisambiguatedSlashToken(
  groupLength: number,
  groupIndex: number,
  baseToken: string,
  baseSlug: string,
  candidateTokens: string[],
  usedTokens: Set<string>,
): string {
  if (groupLength <= 1 || groupIndex === 0) return baseToken
  return pickUniqueSlashToken(candidateTokens, usedTokens, baseSlug)
}

export function assignUniqueTokenWithSuffix(
  initialToken: string,
  baseSlug: string,
  usedTokens: Set<string>,
): string {
  let token = initialToken
  let tokenKey = token.toLowerCase()
  let suffix = 2
  while (usedTokens.has(tokenKey)) {
    token = `/${baseSlug}-${suffix}`
    tokenKey = token.toLowerCase()
    suffix += 1
  }
  usedTokens.add(tokenKey)
  return token
}

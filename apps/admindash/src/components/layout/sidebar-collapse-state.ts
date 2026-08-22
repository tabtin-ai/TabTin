export function shouldAutoExpandActiveGroup(
  previousActiveGroupId: string | null | undefined,
  activeGroupId: string | null
): boolean {
  return Boolean(activeGroupId && previousActiveGroupId !== activeGroupId)
}

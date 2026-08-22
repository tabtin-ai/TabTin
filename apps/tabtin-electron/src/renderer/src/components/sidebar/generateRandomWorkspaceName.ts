const RANDOM_WORKSPACE_NAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** 未填名称且未选目录时的默认展示名：`workspace-` + 6 位随机字符。 */
export function generateRandomWorkspaceName(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  let suffix = ''
  for (let i = 0; i < bytes.length; i++) {
    suffix +=
      RANDOM_WORKSPACE_NAME_ALPHABET[
        bytes[i]! % RANDOM_WORKSPACE_NAME_ALPHABET.length
      ]
  }
  return `workspace-${suffix}`
}

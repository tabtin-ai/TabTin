import { apiClient } from './apiClient'

export interface GenerateCommitMessagePayload {
  organizationId: string
  files: string[]
  diffExcerpt: string
  truncated: boolean
}

export interface GenerateCommitMessageResult {
  commitMessage: string
}

interface GenerateCommitMessageResponse {
  commit_message?: string
}

export async function generateCommitMessage(
  payload: GenerateCommitMessagePayload,
): Promise<GenerateCommitMessageResult> {
  const { data } = await apiClient.post<GenerateCommitMessageResponse>(
    '/chat/git/generate-commit-message',
    {
      organization_id: payload.organizationId,
      files: payload.files,
      diff_excerpt: payload.diffExcerpt,
      truncated: payload.truncated,
    },
  )

  const commitMessage = (data?.commit_message || '').trim()
  if (!commitMessage) {
    throw new Error('empty commit message')
  }
  return { commitMessage }
}

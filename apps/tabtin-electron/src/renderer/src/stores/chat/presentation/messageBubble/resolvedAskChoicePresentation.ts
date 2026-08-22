const OTHER_OPTION_ID = '__other__'

export interface ResolvedAskChoicePresentation {
  questions: Array<{
    questionId: string
    prompt: string
    answers: string[]
  }>
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item) => item !== null) : []
}

export function deriveResolvedAskChoicePresentation(
  metadata: Record<string, unknown> | null | undefined,
): ResolvedAskChoicePresentation | null {
  const hitl = record(metadata?.hitl)
  if (!hitl || text(hitl.kind) !== 'ask_choice' || text(hitl.status) !== 'resolved') return null

  const result = record(hitl.result)
  if (!result) return null
  const outcome = text(result.outcome)
  if (outcome && outcome !== 'answered') return null

  const payload = record(hitl.payload)
  if (!payload) return null
  const questionById = new Map(
    records(payload.questions)
      .map((question) => [text(question.id), question] as const)
      .filter(([id]) => id),
  )
  const response = record(result.response)
  const answerRows = records(result.answers).length > 0
    ? records(result.answers)
    : records(response?.answers)

  const questions = answerRows.flatMap((answer) => {
    const question = questionById.get(text(answer.question_id))
    if (!question) return []
    const prompt = text(question.prompt) || text(question.text)
    if (!prompt) return []

    const optionLabels = new Map(
      records(question.options)
        .map((option) => [text(option.id), text(option.label)] as const)
        .filter(([id, label]) => id && label),
    )
    const freeText = text(answer.free_text)
    const selectedOptions = Array.isArray(answer.selected_options)
      ? answer.selected_options.map(text).filter(Boolean)
      : []
    const visibleAnswers = [
      ...selectedOptions.flatMap((optionId) => {
        if (optionId === OTHER_OPTION_ID && freeText) return []
        const label = optionLabels.get(optionId)
        return label ? [label] : []
      }),
      ...(freeText ? [freeText] : []),
    ].filter((value, index, all) => all.indexOf(value) === index)

    return visibleAnswers.length > 0
      ? [{ questionId: text(answer.question_id), prompt, answers: visibleAnswers }]
      : []
  })

  return questions.length > 0 ? { questions } : null
}

package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.resolvedAskChoiceFact

internal data class AskUserResultQuestion(
    val prompt: String,
    val answers: List<String>,
)

internal data class AskUserResultPresentation(
    val questions: List<AskUserResultQuestion>,
) {
    companion object {
        fun from(message: ChatMessage): AskUserResultPresentation? {
            val fact = message.resolvedAskChoiceFact ?: return null
            return AskUserResultPresentation(
                questions = fact.questions.map {
                    AskUserResultQuestion(prompt = it.prompt, answers = it.answers)
                },
            )
        }
    }
}

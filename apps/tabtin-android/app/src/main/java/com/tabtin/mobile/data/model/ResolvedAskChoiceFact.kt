package com.tabtin.mobile.data.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

internal data class ResolvedAskChoiceQuestion(
    val prompt: String,
    val answers: List<String>,
)

internal data class ResolvedAskChoiceFact(
    val questions: List<ResolvedAskChoiceQuestion>,
)

/**
 * Android Agent timeline deliberately projects only completed ask_choice facts. Other HITL
 * kinds and non-answered terminal outcomes stay internal, matching the legacy timeline policy.
 */

internal val ChatMessage.resolvedAskChoiceFact: ResolvedAskChoiceFact?
    get() {
        if (messageKind != "hitl_interaction") return null
        val hitl = metadata?.get("hitl") as? JsonObject ?: return null
        if (hitl.string("kind") != "ask_choice" || hitl.string("status") != "resolved") {
            return null
        }
        val result = hitl["result"] as? JsonObject ?: return null
        if (result.string("outcome").takeIf { it.isNotBlank() } !in setOf(null, "answered")) {
            return null
        }
        val payload = hitl["payload"] as? JsonObject ?: return null
        val questions = (payload["questions"] as? JsonArray)
            ?.mapNotNull { it as? JsonObject }
            .orEmpty()
        val questionById = questions.associateBy { it.string("id") }
        val answers = resolvedAnswers(result)

        val rows = answers.mapNotNull { answer ->
            val question = questionById[answer.string("question_id")] ?: return@mapNotNull null
            val optionLabels = (question["options"] as? JsonArray)
                ?.mapNotNull { it as? JsonObject }
                ?.associate { it.string("id") to it.string("label") }
                .orEmpty()
            val freeText = answer.string("free_text").takeIf { it.isNotBlank() }
            val selected = (answer["selected_options"] as? JsonArray)
                ?.mapNotNull { it.stringOrNull() }
                ?.filterNot { it == "__other__" && freeText != null }
                ?.map { optionLabels[it].orEmpty().ifBlank { it } }
                .orEmpty()
            val visibleAnswers = (selected + listOfNotNull(freeText)).distinct()
            val prompt = question.string("prompt").ifBlank { question.string("text") }
            if (prompt.isBlank() || visibleAnswers.isEmpty()) return@mapNotNull null
            ResolvedAskChoiceQuestion(prompt = prompt, answers = visibleAnswers)
        }
        return rows.takeIf { it.isNotEmpty() }?.let(::ResolvedAskChoiceFact)
    }

private fun resolvedAnswers(result: JsonObject?): List<JsonObject> {
    if (result == null) return emptyList()
    val direct = result["answers"] as? JsonArray
    val nested = (result["response"] as? JsonObject)?.get("answers") as? JsonArray
    return (direct ?: nested)?.mapNotNull { it as? JsonObject }.orEmpty()
}

private fun JsonObject.string(key: String): String = get(key).stringOrNull().orEmpty()

private fun JsonElement?.stringOrNull(): String? = try {
    this?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
} catch (_: IllegalArgumentException) {
    null
}

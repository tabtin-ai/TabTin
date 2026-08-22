package com.tabtin.mobile.features.conversation

/** 子 Agent 卡标题只展示用户可读语义，内部 UUID / run / model 键永不作为正文兜底。 */
internal object SubagentDisplayTitle {
    private val uuid = Regex(
        """(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$""",
    )
    private val internalId = Regex(
        """(?i)^(?:run|step|toolu|call|subagent|agent|task|msg|model)[-_][a-z0-9._:-]{4,}$""",
    )

    fun resolve(vararg candidates: String?): String? = candidates.firstNotNullOfOrNull { candidate ->
        sanitize(candidate)
            ?.lineSequence()
            ?.firstOrNull(::isReadable)
            ?.take(60)
    }

    /**
     * Remove protocol-only identifier lines while preserving the readable task body. This keeps
     * both the compact card title and the detail sheet from exposing a leading run/model key.
     */
    fun sanitize(value: String?): String? {
        val lines = value
            ?.lineSequence()
            ?.map(String::trim)
            ?.filter(String::isNotEmpty)
            ?.filterNot(::isInternalIdentifier)
            ?.toList()
            .orEmpty()
        if (lines.none(::isReadable)) return null
        return lines.joinToString("\n")
    }

    fun isReadable(value: String): Boolean {
        val normalized = value.trim().trim('`')
        if (normalized.isEmpty() || isInternalIdentifier(normalized)) return false
        return normalized.any { it.isLetter() }
    }

    private fun isInternalIdentifier(value: String): Boolean {
        val normalized = value.trim().trim('`')
        return uuid.matches(normalized) || internalId.matches(normalized)
    }
}

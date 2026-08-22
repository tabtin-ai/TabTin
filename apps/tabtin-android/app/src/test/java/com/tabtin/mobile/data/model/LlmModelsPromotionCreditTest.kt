package com.tabtin.mobile.data.model

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LlmModelsPromotionCreditTest {
    @Test
    fun `decodes promotion credit and builds inline summary`() {
        val model = Json.decodeFromString<LlmModel>(
            """
            {
              "id": "model-1",
              "model_name": "doubao-seed",
              "promotion_credit": {
                "eligible": true,
                "remaining_credits": 8000,
                "total_credits": 10000
              }
            }
            """.trimIndent(),
        )

        assertEquals(8000.0, model.promotionCredit?.remainingCredits)
        assertEquals(10000.0, model.promotionCredit?.totalCredits)
        assertTrue(model.promotionCreditSummary?.startsWith("赠享") == true)
        assertTrue(model.promotionCreditSummary?.endsWith("点券") == true)
    }

    @Test
    fun `missing promotion credit remains compatible`() {
        val model = Json.decodeFromString<LlmModel>("""{"id":"model-1","model_name":"kimi"}""")

        assertNull(model.promotionCredit)
        assertNull(model.promotionCreditSummary)
    }

    @Test
    fun `only eligible settled model requests promotion credit refresh`() {
        val model = Json.decodeFromString<LlmModel>(
            """{"id":"model-1","model_name":"doubao","promotion_credit":{"eligible":true,"remaining_credits":10}}""",
        )

        assertTrue(shouldRefreshPromotionCredit("model-1", listOf(model)))
        assertTrue(!shouldRefreshPromotionCredit("ordinary-model", listOf(model)))
    }

    @Test
    fun `document input capability is fail closed and matches electron precedence`() {
        val topLevel = Json.decodeFromString<LlmModel>(
            """{"id":"model-1","model_name":"kimi","supports_document_input":true}""",
        )
        val resolvedFallback = Json.decodeFromString<LlmModel>(
            """{"id":"model-2","model_name":"kimi","resolved_capabilities":{"supports_document_input":true}}""",
        )
        val topLevelOverride = Json.decodeFromString<LlmModel>(
            """{"id":"model-3","model_name":"text-only","supports_document_input":false,"resolved_capabilities":{"supports_document_input":true}}""",
        )
        val missing = Json.decodeFromString<LlmModel>(
            """{"id":"model-4","model_name":"legacy"}""",
        )

        assertTrue(topLevel.supportsDocumentInput)
        assertTrue(resolvedFallback.supportsDocumentInput)
        assertFalse(topLevelOverride.supportsDocumentInput)
        assertFalse(missing.supportsDocumentInput)
    }

    @Test
    fun `model source distinguishes platform and byok with legacy fallback`() {
        fun model(scope: String? = null): LlmModel = LlmModel(
            id = scope ?: "legacy",
            modelName = "model",
            providerScope = scope,
        )

        assertEquals(LlmModelSource.PLATFORM, model("global").source)
        assertEquals(LlmModelSource.ORGANIZATION_BYOK, model("organization").source)
        assertEquals(LlmModelSource.USER_BYOK, model("user").source)
        assertEquals(LlmModelSource.PLATFORM, model().source)
        assertEquals(LlmModelSource.PLATFORM, model("future-scope").source)
    }
}

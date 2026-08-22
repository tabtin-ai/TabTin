package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.LlmModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ConversationModelSwitchRollbackTest {
    @Test
    fun `failed model switch restores prior runtime selection and exposes error`() {
        val previousModel = model("model-old")
        val optimisticModel = model("model-new")
        val state = ConversationUiState(
            currentModel = optimisticModel,
            contextTierId = "large",
            thinkingMode = "high",
            isSwitchingModel = true,
        )

        val rolledBack = state.rollbackFailedModelSwitch(
            previousModel = previousModel,
            previousContextTierId = "standard",
            previousThinkingMode = "medium",
            message = "切换失败",
        )

        assertEquals(previousModel, rolledBack.currentModel)
        assertEquals("standard", rolledBack.contextTierId)
        assertEquals("medium", rolledBack.thinkingMode)
        assertFalse(rolledBack.isSwitchingModel)
        assertEquals("切换失败", rolledBack.modelSwitchErrorMessage)
        assertEquals("切换失败", rolledBack.errorMessage)
    }

    private fun model(id: String): LlmModel = LlmModel(
        id = id,
        modelName = id,
    )
}

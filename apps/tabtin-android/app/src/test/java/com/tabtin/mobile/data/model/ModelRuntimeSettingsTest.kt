package com.tabtin.mobile.data.model

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelRuntimeSettingsTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `decodes catalog context tiers window and thinking profile`() {
        val model = json.decodeFromString<LlmModel>(
            """
            {
              "id": "model-1",
              "model_name": "claude-sonnet",
              "context_window_tokens": 200000,
              "context_tiers": [
                {
                  "id": "standard",
                  "label": "200K",
                  "is_default": true,
                  "max_input_tokens": null,
                  "tags": [],
                  "has_extra_headers": false,
                  "is_user_selectable": true
                },
                {
                  "id": "long_1m",
                  "label": "1M",
                  "is_default": false,
                  "tags": ["beta"],
                  "has_extra_headers": true,
                  "is_user_selectable": true
                }
              ],
              "runtime_profile": {
                "thinking": {
                  "supported": true,
                  "modes": ["off", "standard", "deep"],
                  "default_mode": "standard"
                }
              }
            }
            """.trimIndent(),
        )

        assertEquals(200000L, model.contextWindowTokens)
        assertEquals(2, model.contextTiers.size)
        assertTrue(model.canSelectContextTier())
        assertTrue(model.shouldShowContextSelector())
        assertTrue(model.hasRuntimeSettings())
        val thinking = requireNotNull(model.catalogThinkingCapability())
        assertEquals(listOf("off", "standard", "deep"), thinking.modes)
        assertEquals("standard", thinking.defaultMode)
    }

    @Test
    fun `single non-selectable tier only shows readonly window`() {
        val model = json.decodeFromString<LlmModel>(
            """
            {
              "id": "model-2",
              "model_name": "gpt",
              "context_window_tokens": 128000,
              "context_tiers": [
                {"id":"default","label":"128K","is_default":true,"is_user_selectable":false}
              ],
              "runtime_profile": {"thinking": {"supported": false, "modes": []}}
            }
            """.trimIndent(),
        )

        assertFalse(model.canSelectContextTier())
        assertTrue(model.shouldShowContextSelector())
        assertNull(model.catalogThinkingCapability())
        assertTrue(model.hasRuntimeSettings())
        assertEquals("128K", formatContextWindowLabel(128000))
    }

    @Test
    fun `forced thinking model hides off mode`() {
        val model = json.decodeFromString<LlmModel>(
            """
            {
              "id": "model-3",
              "model_name": "kimi",
              "runtime_profile": {
                "thinking": {
                  "supported": true,
                  "modes": ["standard", "deep"],
                  "default_mode": "standard"
                }
              }
            }
            """.trimIndent(),
        )

        val thinking = requireNotNull(model.catalogThinkingCapability())
        assertEquals(listOf("standard", "deep"), thinking.modes)
        assertFalse("off" in thinking.modes)
    }

    @Test
    fun `session decodes context tier and thinking mode overrides`() {
        val session = json.decodeFromString<ChatSession>(
            """
            {
              "id": "session-1",
              "context_tier_id": "long_1m",
              "model_param_overrides": {"v": 2, "thinking_mode": "deep"}
            }
            """.trimIndent(),
        )

        assertEquals("long_1m", session.contextTierId)
        assertEquals("deep", session.modelParamOverrides.thinkingMode())
    }

    @Test
    fun `switch model and model-params request bodies match Electron contract`() {
        val switchBody = json.encodeToString(
            SwitchSessionModelRequest(
                modelId = "model-1",
                contextTierId = "long_1m",
            ),
        )
        assertTrue(switchBody.contains("\"model_id\":\"model-1\""))
        assertTrue(switchBody.contains("\"context_tier_id\":\"long_1m\""))

        val paramsBody = json.encodeToString(
            UpdateModelParamsRequest(
                modelParamOverrides = ModelParamOverridesWrite(
                    v = 2,
                    thinkingMode = "deep",
                ),
            ),
        )
        assertTrue(paramsBody.contains("\"model_param_overrides\""))
        assertTrue(paramsBody.contains("\"v\":2"))
        assertTrue(paramsBody.contains("\"thinking_mode\":\"deep\""))
        assertFalse(paramsBody.contains("thinking_level"))
        assertFalse(paramsBody.contains("reasoning_effort"))
    }

    @Test
    fun `thinking mode write preserves performance_profile and omits reasoning_effort`() {
        val existing = JsonObject(
            mapOf(
                "v" to JsonPrimitive(2),
                "thinking_mode" to JsonPrimitive("standard"),
                "performance_profile" to JsonPrimitive("fast"),
            ),
        )
        val merged = modelParamOverridesWriteForThinkingMode(
            thinkingMode = "deep",
            preserving = existing,
        )
        assertEquals(2, merged.v)
        assertEquals("deep", merged.thinkingMode)
        assertEquals("fast", merged.performanceProfile)

        val paramsBody = json.encodeToString(
            UpdateModelParamsRequest(modelParamOverrides = merged),
        )
        assertTrue(paramsBody.contains("\"thinking_mode\":\"deep\""))
        assertTrue(paramsBody.contains("\"performance_profile\":\"fast\""))
        assertFalse(paramsBody.contains("reasoning_effort"))
        assertFalse(paramsBody.contains("thinking_level"))
    }

    @Test
    fun `thinking mode write without existing overrides omits performance_profile`() {
        val merged = modelParamOverridesWriteForThinkingMode(thinkingMode = "off")
        assertEquals("off", merged.thinkingMode)
        assertNull(merged.performanceProfile)
        val paramsBody = json.encodeToString(
            UpdateModelParamsRequest(modelParamOverrides = merged),
        )
        assertFalse(paramsBody.contains("performance_profile"))
    }

    @Test
    fun `runtime summary joins context and thinking labels`() {
        val model = json.decodeFromString<LlmModel>(
            """
            {
              "id": "model-1",
              "model_name": "claude",
              "context_tiers": [
                {"id":"standard","label":"200K","is_default":true,"is_user_selectable":true},
                {"id":"long_1m","label":"1M","is_default":false,"is_user_selectable":true}
              ],
              "runtime_profile": {
                "thinking": {"supported": true, "modes": ["off","standard","deep"], "default_mode": "standard"}
              }
            }
            """.trimIndent(),
        )
        val summary = runtimeSettingsSummary(
            model = model,
            contextTierId = "long_1m",
            thinkingMode = "deep",
            thinkingLabels = mapOf(
                "off" to "关闭",
                "standard" to "标准",
                "deep" to "深度",
            ),
        )
        assertEquals("1M · 深度", summary)
    }

    @Test
    fun `resolveActiveThinkingMode prefers local selection over overrides`() {
        val capability = CatalogThinkingCapability(
            modes = listOf("off", "standard", "deep"),
            defaultMode = "standard",
        )
        val overrides = JsonObject(mapOf("thinking_mode" to JsonPrimitive("deep")))
        assertEquals(
            "off",
            resolveActiveThinkingMode(overrides, "off", capability),
        )
        assertEquals(
            "deep",
            resolveActiveThinkingMode(overrides, null, capability),
        )
        assertEquals(
            "standard",
            resolveActiveThinkingMode(null, null, capability),
        )
    }
}

package com.tabtin.mobile.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import retrofit2.http.Query

class ChatApiHitlFactsContractTest {
    @Test
    fun `message history exposes opt ins for persisted facts and artifact cards`() {
        val method = ChatApi::class.java.methods.single { it.name == "getMessages" }
        val hitlQueryIndex = method.parameterAnnotations.indexOfFirst { annotations ->
            annotations.filterIsInstance<Query>().any { it.value == "include_hitl_facts" }
        }
        val artifactQueryIndex = method.parameterAnnotations.indexOfFirst { annotations ->
            annotations.filterIsInstance<Query>().any { it.value == "expand_artifacts" }
        }

        assertNotNull(method.getAnnotation(retrofit2.http.GET::class.java))
        assertEquals(java.lang.Boolean::class.java, method.parameterTypes[hitlQueryIndex])
        assertEquals(java.lang.Boolean::class.java, method.parameterTypes[artifactQueryIndex])
    }
}

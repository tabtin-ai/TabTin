package com.tabtin.mobile.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import retrofit2.http.GET
import retrofit2.http.Path
import retrofit2.http.Query

class ContextApiMemberSearchContractTest {
    @Test
    fun `organization member endpoint exposes nickname search contract`() {
        val method = ContextApi::class.java.methods.single { it.name == "getMembers" }

        assertEquals(
            "context/organizations/{id}/members",
            method.getAnnotation(GET::class.java)?.value,
        )
        val parameters = method.parameterAnnotations.mapNotNull { annotations ->
            annotations.filterIsInstance<Path>().singleOrNull()?.let { "path:${it.value}" }
                ?: annotations.filterIsInstance<Query>().singleOrNull()?.let { "query:${it.value}" }
        }
        assertNotNull(parameters)
        assertEquals(listOf("path:id", "query:search", "query:search_mode"), parameters)
    }
}

package com.tabtin.mobile.data.api

import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.http.Query

public class UserPortraitApiContractTest {
    @Test
    public fun `all portrait endpoints carry the agent id query`() {
        val methods = UserPortraitApi::class.java.declaredMethods
            .filter { it.name in setOf("getMyPortrait", "submitHint", "triggerDistill", "listSnapshots") }

        assertTrue("Expected all four portrait endpoints", methods.map { it.name }.toSet().size == 4)
        methods.forEach { method ->
            val queryNames = method.parameterAnnotations
                .flatMap { annotations -> annotations.toList() }
                .filterIsInstance<Query>()
                .map { it.value }
            assertTrue("${method.name} must carry agent_id", "agent_id" in queryNames)
        }
    }
}

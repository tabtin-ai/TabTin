package com.tabtin.mobile.data.api

import org.junit.Assert.assertEquals
import org.junit.Test
import retrofit2.http.GET
import retrofit2.http.Path

class ContextApiDeviceMcpContractTest {
    @Test
    fun deviceConnectorShelfUsesCurrentUserDeviceEndpoint() {
        val method = ContextApi::class.java.methods.single { it.name == "getDeviceMcpConnections" }

        assertEquals(
            "context/devices/{deviceId}/mcp-connections",
            method.getAnnotation(GET::class.java)?.value,
        )
        val path = method.parameterAnnotations
            .flatMap { annotations -> annotations.filterIsInstance<Path>() }
            .single()
        assertEquals("deviceId", path.value)
    }
}

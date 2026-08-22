package com.tabtin.mobile.data.model

import org.junit.Assert.assertEquals
import org.junit.Test

/** 组织 MCP 来源映射；挂载开关本轮禁用，不测假成功路径。 */
public class OrgMcpConnectionTest {
    @Test
    public fun sourceKind_remoteDefaultsToOrganization() {
        val connection = OrgMcpConnection(id = "1", scope = "remote")
        assertEquals(OrgMcpSourceKind.ORGANIZATION, connection.sourceKind)
    }

    @Test
    public fun sourceKind_localIsLocal() {
        val connection = OrgMcpConnection(id = "2", scope = "local")
        assertEquals(OrgMcpSourceKind.LOCAL, connection.sourceKind)
    }

    @Test
    public fun sourceKind_unknownTreatedAsOrganization() {
        val connection = OrgMcpConnection(id = "3", scope = "")
        assertEquals(OrgMcpSourceKind.ORGANIZATION, connection.sourceKind)
    }
}

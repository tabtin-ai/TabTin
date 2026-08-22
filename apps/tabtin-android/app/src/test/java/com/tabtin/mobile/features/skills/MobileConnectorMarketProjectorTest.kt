package com.tabtin.mobile.features.skills

import com.tabtin.mobile.data.model.MobileConnectorDeviceLoader
import com.tabtin.mobile.data.model.MobileConnectorMarketFilters
import com.tabtin.mobile.data.model.MobileConnectorMarketItem
import com.tabtin.mobile.data.model.MobileConnectorMarketProjector
import com.tabtin.mobile.data.model.MobileConnectorMarketSource
import com.tabtin.mobile.data.model.OrgMcpConnection
import com.tabtin.mobile.data.model.RuntimeDevice
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class MobileConnectorMarketProjectorTest {
    @Test
    fun recommendedShelfUsesDesktopOrderAndApprovedCatalogIntersection() {
        val manifest =
            """
            {
              "brands": {
                "github": {
                  "status": "approved",
                  "title": "GitHub",
                  "file": "github.svg",
                  "match": {
                    "ids": ["github"],
                    "hosts": ["api.githubcopilot.com"]
                  }
                },
                "canva": {
                  "status": "deferred",
                  "title": "Canva",
                  "file": null,
                  "match": {
                    "ids": ["canva"],
                    "hosts": ["mcp.canva.com"]
                  }
                },
                "unknown": {
                  "status": "approved",
                  "title": "Unknown",
                  "file": "unknown.svg",
                  "match": {"ids": ["unknown"], "hosts": []}
                },
                "vercel": {
                  "status": "approved",
                  "title": "Vercel",
                  "file": "vercel.svg",
                  "match": {"ids": ["vercel"], "hosts": ["mcp.vercel.com"]}
                },
                "stripe": {
                  "status": "approved",
                  "title": "Stripe",
                  "file": "stripe.svg",
                  "match": {"ids": ["stripe"], "hosts": ["mcp.stripe.com"]}
                }
              }
            }
            """.trimIndent()

        val items = MobileConnectorMarketProjector.recommendedFromManifest(manifest)

        assertEquals(listOf("vercel", "github", "stripe"), items.map { it.catalogId })
        assertEquals(listOf("Vercel", "GitHub", "Stripe"), items.map { it.name })
    }

    @Test
    fun mineShelfPreservesSameNamedConnectorsAcrossDevices() {
        val connection = OrgMcpConnection(
            id = "same-connection-id",
            name = "Local Tools",
            transport = "stdio",
        )

        val items = MobileConnectorMarketProjector.mineFromDeviceBatches(
            listOf(
                MobileConnectorDeviceLoader.DeviceBatch(
                    deviceId = "device-a",
                    deviceName = "MacBook Pro",
                    connections = listOf(connection),
                ),
                MobileConnectorDeviceLoader.DeviceBatch(
                    deviceId = "device-b",
                    deviceName = "Office Mac",
                    connections = listOf(connection),
                ),
            ),
        )

        assertEquals(2, items.size)
        assertEquals(setOf("MacBook Pro", "Office Mac"), items.map { it.deviceName }.toSet())
        assertEquals(2, items.map { it.stableKey }.toSet().size)
        assertEquals(
            setOf(
                "mine:device-a:same-connection-id",
                "mine:device-b:same-connection-id",
            ),
            items.map { it.stableKey }.toSet(),
        )
    }

    @Test
    fun mineLoaderKeepsSuccessfulDevicesWhenOneDeviceFails() = runTest {
        val devices = listOf(
            RuntimeDevice(id = "device-a", name = "MacBook Pro"),
            RuntimeDevice(id = "device-b", name = "Offline Mac"),
            RuntimeDevice(id = "device-c", name = "Office Mac"),
        )

        val result = MobileConnectorDeviceLoader.load(devices) { deviceId ->
            if (deviceId == "device-b") error("device unavailable")
            listOf(
                OrgMcpConnection(
                    id = "connection-$deviceId",
                    name = "Local Tools",
                    transport = "stdio",
                ),
            )
        }

        assertEquals(3, result.totalDeviceCount)
        assertEquals(1, result.failedDeviceCount)
        assertEquals(setOf("device-a", "device-c"), result.batches.map { it.deviceId }.toSet())
    }

    @Test
    fun mineLoaderDoesNotSwallowCancellation() {
        assertThrows(CancellationException::class.java) {
            runTest {
                MobileConnectorDeviceLoader.load(
                    devices = listOf(RuntimeDevice(id = "device-a")),
                    fetchConnections = { throw CancellationException("cancelled") },
                )
            }
        }
    }

    @Test
    fun connectorSearchOnlyReadsTheSelectedShelfVisibleFields() {
        val recommended = listOf(
            MobileConnectorMarketItem(
                stableKey = "recommended:github",
                source = MobileConnectorMarketSource.RECOMMENDED,
                name = "GitHub",
            ),
        )
        val organization = listOf(
            MobileConnectorMarketItem(
                stableKey = "organization:notion",
                source = MobileConnectorMarketSource.ORGANIZATION,
                name = "Notion 团队知识库",
                description = "组织共享",
            ),
        )

        assertEquals(
            listOf("GitHub"),
            MobileConnectorMarketFilters.visibleItems(
                source = MobileConnectorMarketSource.RECOMMENDED,
                query = "github",
                recommended = recommended,
                organization = organization,
                mine = emptyList(),
            ).map { it.name },
        )
        assertEquals(
            emptyList<MobileConnectorMarketItem>(),
            MobileConnectorMarketFilters.visibleItems(
                source = MobileConnectorMarketSource.ORGANIZATION,
                query = "github",
                recommended = recommended,
                organization = organization,
                mine = emptyList(),
            ),
        )
    }

    @Test
    fun switchingConnectorShelfClearsOnlyConnectorQuery() {
        assertEquals(
            "",
            MobileConnectorMarketFilters.searchAfterSelecting(
                currentSource = MobileConnectorMarketSource.RECOMMENDED,
                newSource = MobileConnectorMarketSource.ORGANIZATION,
                currentQuery = "GitHub",
            ),
        )
        assertEquals(
            "Local",
            MobileConnectorMarketFilters.searchAfterSelecting(
                currentSource = MobileConnectorMarketSource.MINE,
                newSource = MobileConnectorMarketSource.MINE,
                currentQuery = "Local",
            ),
        )
    }

    @Test
    fun mobileProjectionNeverCarriesRuntimeSecrets() {
        val fieldNames = MobileConnectorMarketItem::class.java.declaredFields.map { it.name }.toSet()

        assertEquals(
            emptySet<String>(),
            fieldNames.intersect(setOf("config", "args", "credential", "command", "cwd")),
        )
    }
}

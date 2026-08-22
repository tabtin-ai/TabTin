package com.tabtin.mobile.data.model

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.supervisorScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

public enum class MobileConnectorMarketSource {
    RECOMMENDED,
    ORGANIZATION,
    MINE,
}

/** 移动连接器市场只读投影；刻意不承载 config、args 或凭据字段。 */
public data class MobileConnectorMarketItem(
    val stableKey: String,
    val source: MobileConnectorMarketSource,
    val name: String,
    val description: String = "",
    val descriptionKey: String? = null,
    val catalogId: String? = null,
    val endpoint: String = "",
    val transport: String = "",
    val deviceId: String? = null,
    val deviceName: String? = null,
)

/**
 * 把各来源的异构数据收口为移动端安全展示模型。
 *
 * 推荐货架只接受品牌清单中已批准且有可分发图标的项；未获批准的品牌不会因
 * Electron 推荐目录中存在同名条目而提前出现在移动端。
 */
public object MobileConnectorMarketProjector {
    private val manifestJson = Json { ignoreUnknownKeys = true }
    /** Electron `RECOMMENDED_CONNECTOR_CATALOG` 顺序；Canva 会再被 manifest 审批状态挡掉。 */
    private val recommendedCatalogOrder = listOf(
        "vercel",
        "github",
        "stripe",
        "notion",
        "canva",
        "supabase",
        "neon",
        "cloudflare",
        "tianyancha",
        "hithink-a-share",
        "dingtalk",
    )

    public fun recommendedFromManifest(rawManifest: String): List<MobileConnectorMarketItem> {
        val brands = manifestJson.parseToJsonElement(rawManifest).jsonObject["brands"]?.jsonObject
            ?: return emptyList()
        return recommendedCatalogOrder.mapNotNull { brandKey ->
            val element = brands[brandKey] ?: return@mapNotNull null
            val brand = element.jsonObject
            val status = brand["status"]?.jsonPrimitive?.contentOrNull
            val file = brand["file"]?.jsonPrimitive?.contentOrNull
            if (status != "approved" || file.isNullOrBlank()) return@mapNotNull null

            val match = brand["match"]?.jsonObject
            val catalogId = match?.get("ids")?.jsonArray
                ?.firstNotNullOfOrNull { it.jsonPrimitive.contentOrNull?.takeIf(String::isNotBlank) }
                ?: brandKey
            val endpointHost = match?.get("hosts")?.jsonArray
                ?.firstNotNullOfOrNull { it.jsonPrimitive.contentOrNull?.takeIf(String::isNotBlank) }
                .orEmpty()
            MobileConnectorMarketItem(
                stableKey = "recommended:$catalogId",
                source = MobileConnectorMarketSource.RECOMMENDED,
                name = brand["title"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
                    ?: catalogId,
                descriptionKey = brandKey,
                catalogId = catalogId,
                endpoint = endpointHost.takeIf(String::isNotBlank)?.let { "https://$it" }.orEmpty(),
            )
        }
    }

    public fun organizationFromConnections(
        connections: List<OrgMcpConnection>,
    ): List<MobileConnectorMarketItem> = connections.map { connection ->
        MobileConnectorMarketItem(
            stableKey = "organization:${connection.id}",
            source = MobileConnectorMarketSource.ORGANIZATION,
            name = connection.name.ifBlank { connection.id },
            description = connection.description,
            endpoint = connection.endpoint,
            transport = connection.transport,
        )
    }

    public fun mineFromDeviceBatches(
        batches: List<MobileConnectorDeviceLoader.DeviceBatch>,
    ): List<MobileConnectorMarketItem> = batches.flatMap { batch ->
        batch.connections.map { connection ->
            MobileConnectorMarketItem(
                stableKey = "mine:${batch.deviceId}:${connection.id}",
                source = MobileConnectorMarketSource.MINE,
                name = connection.name.ifBlank { connection.id },
                description = connection.description,
                endpoint = connection.endpoint,
                transport = connection.transport,
                deviceId = batch.deviceId,
                deviceName = batch.deviceName,
            )
        }
    }
}

/** 当前连接器货架的纯筛选规则；不会跨来源搜索。 */
public object MobileConnectorMarketFilters {
    public fun visibleItems(
        source: MobileConnectorMarketSource,
        query: String,
        recommended: List<MobileConnectorMarketItem>,
        organization: List<MobileConnectorMarketItem>,
        mine: List<MobileConnectorMarketItem>,
    ): List<MobileConnectorMarketItem> {
        val items = when (source) {
            MobileConnectorMarketSource.RECOMMENDED -> recommended
            MobileConnectorMarketSource.ORGANIZATION -> organization
            MobileConnectorMarketSource.MINE -> mine
        }
        val normalizedQuery = query.trim()
        if (normalizedQuery.isEmpty()) return items
        return items.filter { item ->
            listOf(
                item.name,
                item.description,
                item.transport,
                item.deviceName.orEmpty(),
            ).joinToString(" ").contains(normalizedQuery, ignoreCase = true)
        }
    }

    public fun searchAfterSelecting(
        currentSource: MobileConnectorMarketSource,
        newSource: MobileConnectorMarketSource,
        currentQuery: String,
    ): String = if (currentSource == newSource) currentQuery else ""
}

/**
 * 当前用户设备连接器的并发读取策略。
 *
 * 每台设备是独立故障域：一台设备不可用时仍返回其他设备的结果；取消信号必须
 * 继续向上传播，避免页面离开或组织切换后旧请求继续占用资源。
 */
public object MobileConnectorDeviceLoader {
    public data class DeviceBatch(
        val deviceId: String,
        val deviceName: String,
        val connections: List<OrgMcpConnection>,
    )

    public data class Result(
        val batches: List<DeviceBatch>,
        val failedDeviceCount: Int,
        val totalDeviceCount: Int,
    )

    private sealed interface DeviceResult {
        data class Success(val batch: DeviceBatch) : DeviceResult
        data object Failure : DeviceResult
    }

    public suspend fun load(
        devices: List<RuntimeDevice>,
        fetchConnections: suspend (deviceId: String) -> List<OrgMcpConnection>,
    ): Result = supervisorScope {
        val deviceResults = devices.map { device ->
            async {
                try {
                    DeviceResult.Success(
                        DeviceBatch(
                            deviceId = device.id,
                            deviceName = device.name?.trim().orEmpty().ifBlank { device.id },
                            connections = fetchConnections(device.id),
                        ),
                    )
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    DeviceResult.Failure
                }
            }
        }.awaitAll()

        Result(
            batches = deviceResults.mapNotNull { result ->
                (result as? DeviceResult.Success)?.batch
            },
            failedDeviceCount = deviceResults.count { it is DeviceResult.Failure },
            totalDeviceCount = devices.size,
        )
    }
}

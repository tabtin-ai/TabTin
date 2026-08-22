package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.DocApi
import com.tabtin.mobile.data.api.TabDataApi
import com.tabtin.mobile.data.model.SharedResourceItem
import com.tabtin.mobile.data.model.SharedResourcesAggregator
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 「分享给我」聚合仓库：并行拉 tabdoc / tabdata shared-with-me，用
 * [SharedResourcesAggregator] 做降级与合并排序。
 *
 * 空 [organizationId] 必须拦截：后端 `if organization_id` 把空串当不过滤，
 * 会漏出其他组织的分享项。
 */
@Singleton
public class SharedResourcesRepository @Inject constructor(
    private val docApi: DocApi,
    private val tabDataApi: TabDataApi,
) {
    public suspend fun listSharedWithMe(organizationId: String): List<SharedResourceItem> {
        val organization = organizationId.trim()
        require(organization.isNotEmpty()) {
            "shared-with-me requires a non-blank organizationId"
        }

        return coroutineScope {
            val docsDeferred = async {
                fetchSource { docApi.listSharedWithMe(organization).unwrap() }
            }
            val tablesDeferred = async {
                fetchSource { tabDataApi.listSharedWithMe(organization).unwrap() }
            }
            SharedResourcesAggregator.resolve(
                docs = docsDeferred.await(),
                tables = tablesDeferred.await(),
            )
        }
    }

    /**
     * 单来源失败降级为 null；取消原样上抛，避免被误判成「两边都挂了」。
     */
    private suspend fun <T> fetchSource(block: suspend () -> T): T? {
        return try {
            block()
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            null
        }
    }
}

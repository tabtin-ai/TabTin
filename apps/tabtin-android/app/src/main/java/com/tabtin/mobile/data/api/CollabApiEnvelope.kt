package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.AppError
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Collab API 使用的 `{status,data}` 信封，与业务 API 的 `{success,data}` 不同。 */
@Serializable
public data class CollabApiEnvelope<T>(
    public val status: String,
    public val data: T? = null,
    public val message: String? = null,
    @SerialName("error_type") public val errorType: String? = null,
) {
    public fun unwrap(): T {
        if (status != "ok" || data == null) {
            throw AppError.RequestFailed(message, errorType)
        }
        return data
    }
}

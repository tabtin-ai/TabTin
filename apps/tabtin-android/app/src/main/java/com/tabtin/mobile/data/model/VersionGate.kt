package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * 后端 `/client/version-gate` 返回的门禁决策。
 *
 * action 由后端算好（none / soft / force），客户端只执行不自比版本；
 * 未知取值按放行处理（isForce/isSoft 均为 false）。
 */
@Serializable
public data class VersionGateDecision(
    val action: String = "none",
    @SerialName("store_url") val storeUrl: String = "",
    val title: String = "",
    val message: String = "",
    @SerialName("latest_version") val latestVersion: String = "",
    /** 最新 build 号；作为软提示「稍后」去重键：同一 latestBuild 关一次后不再弹。 */
    @SerialName("latest_build") val latestBuild: Int = 0,
) {
    public val isForce: Boolean get() = action == "force"
    public val isSoft: Boolean get() = action == "soft"

    /** 实际跳转地址：优先用后端下发的 store_url，为空则回退本地默认落地页。 */
    public val resolvedStoreUrl: String get() = storeUrl.ifBlank { DEFAULT_STORE_URL }

    public companion object {
        /** 安卓默认更新落地页：用户在此选择应用商店 / 直接下载，避免漏配置把用户卡死。 */
        public const val DEFAULT_STORE_URL: String = "https://www.example.com/"
    }
}

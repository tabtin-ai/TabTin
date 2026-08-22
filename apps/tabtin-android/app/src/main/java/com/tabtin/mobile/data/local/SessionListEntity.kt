package com.tabtin.mobile.data.local

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey
import com.tabtin.mobile.data.api.json as ApiJson
import com.tabtin.mobile.data.model.AllChatSession
import kotlinx.serialization.builtins.ListSerializer

@Entity(tableName = "cached_session_lists")
public data class SessionListEntity(
    @PrimaryKey val scope: String,
    @ColumnInfo(name = "payload_json") val payloadJson: String,
    @ColumnInfo(name = "cached_at") val cachedAt: Long = System.currentTimeMillis(),
) {
    public fun toRecentSessions(): List<AllChatSession> = try {
        ApiJson.decodeFromString(ListSerializer(AllChatSession.serializer()), payloadJson)
    } catch (_: Exception) {
        emptyList()
    }

    public companion object {
        public fun recentScope(organizationId: String): String = "recent:$organizationId"

        public fun fromRecent(organizationId: String, sessions: List<AllChatSession>): SessionListEntity? {
            if (organizationId.isBlank() || sessions.isEmpty()) return null
            return try {
                SessionListEntity(
                    scope = recentScope(organizationId),
                    payloadJson = ApiJson.encodeToString(ListSerializer(AllChatSession.serializer()), sessions),
                )
            } catch (_: Exception) {
                null
            }
        }
    }
}

package com.tabtin.mobile.data.local

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import com.tabtin.mobile.data.api.json as ApiJson
import com.tabtin.mobile.data.model.ChatMessage

@Entity(
    tableName = "cached_messages",
    indices = [
        Index("session_id", "created_at"),
        Index("session_id"),
    ],
)
public data class MessageEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "session_id") val sessionId: String,
    val role: String,
    val content: String,
    @ColumnInfo(name = "blocks_json") val blocksJsonStr: String? = null,
    @ColumnInfo(name = "agent_type") val agentType: String? = null,
    @ColumnInfo(name = "agent_id") val agentId: String? = null,
    @ColumnInfo(name = "model_name") val modelName: String? = null,
    @ColumnInfo(name = "created_at") val createdAt: String? = null,
    @ColumnInfo(name = "error_category") val errorCategory: String? = null,
    @ColumnInfo(name = "error_code") val errorCode: String? = null,
) {
    public fun toChatMessage(): ChatMessage = ChatMessage(
        id = id,
        role = role,
        content = content,
        blocksJson = blocksJsonStr?.let { jsonStr ->
            try {
                // Wave 2 prerequisite：用共用 `ApiClient.json`（ignoreUnknownKeys = true）
                // 反序列化 Room 持久化的 blocks_json，让旧 Android 客户端读到包含
                // widget kind 字段（code / widget_id / format / image_url）的历史消息时
                // 不会因未知字段 throw 把整列表 catch 成 null —— 用户至少能看到老的
                // 文本/工具调用 block。
                ApiJson.decodeFromString<List<com.tabtin.mobile.data.model.BlockItem>>(jsonStr)
            } catch (_: Exception) { null }
        },
        agentType = agentType,
        agentId = agentId,
        modelName = modelName,
        createdAt = createdAt,
        errorCategory = errorCategory,
        errorCode = errorCode,
    )

    public companion object {
        public fun from(sessionId: String, msg: ChatMessage): MessageEntity = MessageEntity(
            id = msg.effectiveId,
            sessionId = sessionId,
            role = msg.role,
            content = msg.content,
            blocksJsonStr = msg.blocksJson?.let { blocks ->
                try {
                    // 与 toChatMessage() 解码侧用同一个 ApiJson 配置，序列化器
                    // 复用 `data class @Serializable` 自动生成的 KSerializer。
                    ApiJson.encodeToString(
                        kotlinx.serialization.builtins.ListSerializer(com.tabtin.mobile.data.model.BlockItem.serializer()),
                        blocks,
                    )
                } catch (_: Exception) { null }
            },
            agentType = msg.agentType,
            agentId = msg.agentId,
            modelName = msg.modelName,
            createdAt = msg.createdAt,
            errorCategory = msg.errorCategory,
            errorCode = msg.errorCode,
        )
    }
}

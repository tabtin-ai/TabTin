package com.tabtin.mobile.data.local

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction

@Entity(
    tableName = "im_cached_messages",
    primaryKeys = ["scope_id", "conversation_id", "message_id"],
    indices = [
        Index("scope_id", "conversation_id", "seq"),
        Index("scope_id", "cached_at"),
    ],
)
public data class ImCachedMessageEntity(
    @ColumnInfo(name = "scope_id") val scopeId: String,
    @ColumnInfo(name = "conversation_id") val conversationId: String,
    @ColumnInfo(name = "message_id") val messageId: Int,
    val seq: Int,
    val payload: String,
    @ColumnInfo(name = "cached_at") val cachedAt: Long,
)

@Entity(
    tableName = "im_pinned_messages",
    primaryKeys = ["scope_id", "conversation_id", "message_id"],
    indices = [Index("scope_id", "conversation_id", "seq")],
)
public data class ImPinnedMessageEntity(
    @ColumnInfo(name = "scope_id") val scopeId: String,
    @ColumnInfo(name = "conversation_id") val conversationId: String,
    @ColumnInfo(name = "message_id") val messageId: Int,
    val seq: Int,
    val payload: String,
    @ColumnInfo(name = "cached_at") val cachedAt: Long,
)

@Entity(
    tableName = "im_read_waterlines",
    primaryKeys = ["scope_id", "conversation_id", "reader_id"],
    indices = [Index("scope_id", "conversation_id")],
)
public data class ImReadWaterlineEntity(
    @ColumnInfo(name = "scope_id") val scopeId: String,
    @ColumnInfo(name = "conversation_id") val conversationId: String,
    @ColumnInfo(name = "reader_id") val readerId: String,
    val seq: Int,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

@Dao
public interface ImMessageCacheDao {
    @Query(
        """
        SELECT * FROM im_cached_messages
        WHERE scope_id = :scopeId AND conversation_id = :conversationId
        ORDER BY seq ASC
        """,
    )
    public suspend fun getMessages(scopeId: String, conversationId: String): List<ImCachedMessageEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    public suspend fun insertMessages(messages: List<ImCachedMessageEntity>)

    @Query("DELETE FROM im_cached_messages WHERE scope_id = :scopeId AND conversation_id = :conversationId")
    public suspend fun deleteMessages(scopeId: String, conversationId: String)

    @Transaction
    public suspend fun replaceMessages(
        scopeId: String,
        conversationId: String,
        messages: List<ImCachedMessageEntity>,
    ) {
        deleteMessages(scopeId, conversationId)
        if (messages.isNotEmpty()) insertMessages(messages)
    }

    @Query(
        """
        SELECT * FROM im_pinned_messages
        WHERE scope_id = :scopeId AND conversation_id = :conversationId
        ORDER BY seq DESC
        """,
    )
    public suspend fun getPinnedMessages(scopeId: String, conversationId: String): List<ImPinnedMessageEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    public suspend fun insertPinnedMessages(messages: List<ImPinnedMessageEntity>)

    @Query("DELETE FROM im_pinned_messages WHERE scope_id = :scopeId AND conversation_id = :conversationId")
    public suspend fun deletePinnedMessages(scopeId: String, conversationId: String)

    @Transaction
    public suspend fun replacePinnedMessages(
        scopeId: String,
        conversationId: String,
        messages: List<ImPinnedMessageEntity>,
    ) {
        deletePinnedMessages(scopeId, conversationId)
        if (messages.isNotEmpty()) insertPinnedMessages(messages)
    }

    @Query(
        """
        SELECT conversation_id FROM im_cached_messages
        WHERE scope_id = :scopeId
        GROUP BY conversation_id
        ORDER BY MAX(cached_at) DESC
        """,
    )
    public suspend fun conversationIdsByRecency(scopeId: String): List<String>

    @Query("DELETE FROM im_cached_messages WHERE scope_id = :scopeId AND conversation_id IN (:conversationIds)")
    public suspend fun deleteConversations(scopeId: String, conversationIds: List<String>)

    @Query("DELETE FROM im_read_waterlines WHERE scope_id = :scopeId AND conversation_id IN (:conversationIds)")
    public suspend fun deleteReadWaterlinesForConversations(scopeId: String, conversationIds: List<String>)

    @Query("DELETE FROM im_pinned_messages WHERE scope_id = :scopeId AND conversation_id IN (:conversationIds)")
    public suspend fun deletePinnedMessagesForConversations(scopeId: String, conversationIds: List<String>)

    @Query("SELECT * FROM im_read_waterlines WHERE scope_id = :scopeId AND conversation_id = :conversationId")
    public suspend fun getReadWaterlines(scopeId: String, conversationId: String): List<ImReadWaterlineEntity>

    @Query(
        """
        SELECT * FROM im_read_waterlines
        WHERE scope_id = :scopeId AND conversation_id = :conversationId AND reader_id = :readerId
        LIMIT 1
        """,
    )
    public suspend fun getReadWaterline(
        scopeId: String,
        conversationId: String,
        readerId: String,
    ): ImReadWaterlineEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    public suspend fun upsertReadWaterline(waterline: ImReadWaterlineEntity)

    @Query("DELETE FROM im_read_waterlines WHERE scope_id = :scopeId AND conversation_id = :conversationId")
    public suspend fun deleteReadWaterlines(scopeId: String, conversationId: String)

    @Query("DELETE FROM im_cached_messages")
    public suspend fun deleteAllMessages()

    @Query("DELETE FROM im_read_waterlines")
    public suspend fun deleteAllReadWaterlines()

    @Query("DELETE FROM im_pinned_messages")
    public suspend fun deleteAllPinnedMessages()
}

package com.tabtin.mobile.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
public interface MessageDao {
    @Query("SELECT * FROM cached_messages WHERE session_id = :sessionId ORDER BY created_at ASC LIMIT :limit")
    public suspend fun getMessages(sessionId: String, limit: Int = 200): List<MessageEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    public suspend fun insertAll(messages: List<MessageEntity>)

    @Query("DELETE FROM cached_messages WHERE session_id = :sessionId")
    public suspend fun deleteBySession(sessionId: String)

    @Query("DELETE FROM cached_messages")
    public suspend fun deleteAll()

    @Query("SELECT COUNT(*) FROM cached_messages WHERE session_id = :sessionId")
    public suspend fun countBySession(sessionId: String): Int

    @Query("SELECT DISTINCT session_id FROM cached_messages")
    public suspend fun getAllSessionIds(): List<String>
}

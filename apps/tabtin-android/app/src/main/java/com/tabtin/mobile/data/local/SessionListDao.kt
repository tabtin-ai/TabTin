package com.tabtin.mobile.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
public interface SessionListDao {
    @Query("SELECT * FROM cached_session_lists WHERE scope = :scope LIMIT 1")
    public suspend fun get(scope: String): SessionListEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    public suspend fun upsert(entity: SessionListEntity)

    @Query("DELETE FROM cached_session_lists WHERE scope = :scope")
    public suspend fun delete(scope: String)

    @Query("DELETE FROM cached_session_lists")
    public suspend fun deleteAll()

    @Query(
        """
        DELETE FROM cached_session_lists
        WHERE scope NOT IN (
            SELECT scope FROM cached_session_lists
            ORDER BY cached_at DESC
            LIMIT :keep
        )
        """
    )
    public suspend fun evictOldScopes(keep: Int = 40)
}

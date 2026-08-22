package com.tabtin.mobile.data.local

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Delete
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Entity(
    tableName = "queued_outgoing_messages",
    indices = [Index("session_id", "created_at")],
)
public data class QueuedOutgoingMessageEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "session_id") val sessionId: String,
    val text: String,
    @ColumnInfo(name = "model_id") val modelId: String?,
    @ColumnInfo(name = "agent_mode") val agentMode: String?,
    @ColumnInfo(name = "approval_mode") val approvalMode: String?,
    @ColumnInfo(name = "blocks_json") val blocksJson: String?,
    @ColumnInfo(name = "client_event_id") val clientEventId: String?,
    @ColumnInfo(name = "server_message_id") val serverMessageId: String?,
    @ColumnInfo(name = "task_id") val taskId: String?,
    /** 入队时冻结的 Focus JSON；重试只读本列，不读此刻 Workbench。 */
    @ColumnInfo(name = "focus_json") val focusJson: String? = null,
    val status: String,
    @ColumnInfo(name = "attempt_count") val attemptCount: Int,
    @ColumnInfo(name = "last_error") val lastError: String?,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

@Dao
public interface QueuedOutgoingMessageDao {
    @Query("SELECT * FROM queued_outgoing_messages WHERE session_id = :sessionId ORDER BY created_at ASC")
    public suspend fun listForSession(sessionId: String): List<QueuedOutgoingMessageEntity>

    @Query("SELECT * FROM queued_outgoing_messages WHERE id = :id LIMIT 1")
    public suspend fun find(id: String): QueuedOutgoingMessageEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    public suspend fun upsert(entity: QueuedOutgoingMessageEntity)

    @Delete
    public suspend fun delete(entity: QueuedOutgoingMessageEntity)

    @Query("DELETE FROM queued_outgoing_messages WHERE id = :id")
    public suspend fun deleteById(id: String)

    @Query(
        """
        UPDATE queued_outgoing_messages
        SET status = 'WAITING', last_error = NULL, updated_at = :updatedAt
        WHERE session_id = :sessionId AND status = 'SENDING'
        """
    )
    public suspend fun recoverSendingForSession(sessionId: String, updatedAt: Long): Int
}

@Database(
    entities = [QueuedOutgoingMessageEntity::class],
    version = 4,
    exportSchema = false,
)
public abstract class OutgoingMessageQueueDatabase : RoomDatabase() {
    public abstract fun queuedOutgoingMessageDao(): QueuedOutgoingMessageDao
}

/** Additive queue upgrade. Existing rows keep using their primary-key id as the idempotency key. */
public val MIGRATION_1_2: Migration = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE queued_outgoing_messages ADD COLUMN client_event_id TEXT")
        db.execSQL("ALTER TABLE queued_outgoing_messages ADD COLUMN server_message_id TEXT")
        db.execSQL("ALTER TABLE queued_outgoing_messages ADD COLUMN task_id TEXT")
    }
}

/** Add the per-message approval setting without changing legacy queue semantics. */
public val MIGRATION_2_3: Migration = object : Migration(2, 3) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE queued_outgoing_messages ADD COLUMN approval_mode TEXT")
    }
}

/** Freeze Focus snapshot JSON on each queue row; legacy rows remain null-compatible. */
public val MIGRATION_3_4: Migration = object : Migration(3, 4) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE queued_outgoing_messages ADD COLUMN focus_json TEXT")
    }
}

@Module
@InstallIn(SingletonComponent::class)
internal object OutgoingMessageQueueDatabaseModule {
    @Provides
    @Singleton
    public fun provideOutgoingMessageQueueDatabase(
        @ApplicationContext context: Context,
    ): OutgoingMessageQueueDatabase =
        Room.databaseBuilder(
            context,
            OutgoingMessageQueueDatabase::class.java,
            "tabtin_outgoing_message_queue",
        )
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)
            .build()

    @Provides
    public fun provideQueuedOutgoingMessageDao(
        db: OutgoingMessageQueueDatabase,
    ): QueuedOutgoingMessageDao = db.queuedOutgoingMessageDao()
}

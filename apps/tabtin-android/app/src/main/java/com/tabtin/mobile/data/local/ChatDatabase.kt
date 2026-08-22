package com.tabtin.mobile.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * 纯缓存数据库：存储消息离线缓存，数据可随时从服务端重新拉取。
 * 使用 fallbackToDestructiveMigration 是安全的——迁移失败时清空缓存，
 * 用户下次进入会话时会自动从 API 重新加载。
 *
 * 如果未来加入不可重建的数据（如用户本地设置），必须提供正式 Migration。
 */
@Database(
    entities = [
        MessageEntity::class,
        SessionListEntity::class,
        ImCachedMessageEntity::class,
        ImPinnedMessageEntity::class,
        ImReadWaterlineEntity::class,
    ],
    version = 5,
    exportSchema = false,
)
internal abstract class ChatDatabase : RoomDatabase() {
    public abstract fun messageDao(): MessageDao
    public abstract fun sessionListDao(): SessionListDao
    public abstract fun imMessageCacheDao(): ImMessageCacheDao
}

@Module
@InstallIn(SingletonComponent::class)
internal object ChatDatabaseModule {
    @Provides
    @Singleton
    public fun provideDatabase(@ApplicationContext context: Context): ChatDatabase =
        Room.databaseBuilder(context, ChatDatabase::class.java, "tabtin_chat_cache")
            // Room 2.7.0 起 no-arg `fallbackToDestructiveMigration()` 被 deprecated；新签名要求显式
            // 声明降级策略。本数据库定位为纯缓存（见 line 14-19 注释），迁移失败时清空所有表是合法
            // 兜底——dropAllTables = true 与原 no-arg 行为字面等价。
            .fallbackToDestructiveMigration(dropAllTables = true)
            .build()

    @Provides
    public fun provideMessageDao(db: ChatDatabase): MessageDao = db.messageDao()

    @Provides
    public fun provideSessionListDao(db: ChatDatabase): SessionListDao = db.sessionListDao()

    @Provides
    public fun provideImMessageCacheDao(db: ChatDatabase): ImMessageCacheDao = db.imMessageCacheDao()
}

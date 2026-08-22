package com.tabtin.mobile.data.local

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class OutgoingMessageQueueMigrationTest {
    private lateinit var context: Context
    private val databaseName = "outgoing-queue-migration-test"

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.deleteDatabase(databaseName)
    }

    @After
    fun tearDown() {
        context.deleteDatabase(databaseName)
    }

    @Test
    fun `migration 1 to 2 preserves rows and adds nullable acknowledgement columns`() {
        SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(databaseName), null).use { db ->
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS queued_outgoing_messages (
                    id TEXT NOT NULL PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    text TEXT NOT NULL,
                    model_id TEXT,
                    agent_mode TEXT,
                    blocks_json TEXT,
                    status TEXT NOT NULL,
                    attempt_count INTEGER NOT NULL,
                    last_error TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            db.execSQL(
                "CREATE INDEX IF NOT EXISTS index_queued_outgoing_messages_session_id_created_at " +
                    "ON queued_outgoing_messages (session_id, created_at)",
            )
            db.execSQL(
                "INSERT INTO queued_outgoing_messages " +
                    "(id, session_id, text, status, attempt_count, created_at, updated_at) " +
                    "VALUES ('legacy-id', 'session-1', 'hello', 'WAITING', 0, 1, 1)",
            )
            db.version = 1
        }

        val room = Room.databaseBuilder(context, OutgoingMessageQueueDatabase::class.java, databaseName)
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)
            .allowMainThreadQueries()
            .build()
        try {
            val row = room.queuedOutgoingMessageDao().let { dao ->
                kotlinx.coroutines.runBlocking { dao.find("legacy-id") }
            }
            assertEquals("legacy-id", row?.id)
            assertEquals("hello", row?.text)
            assertNull(row?.clientEventId)
            assertNull(row?.serverMessageId)
            assertNull(row?.taskId)
            assertNull(row?.focusJson)
        } finally {
            room.close()
        }
    }

    @Test
    fun `migration 2 to 3 preserves rows and adds nullable approval mode`() {
        SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(databaseName), null).use { db ->
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS queued_outgoing_messages (
                    id TEXT NOT NULL PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    text TEXT NOT NULL,
                    model_id TEXT,
                    agent_mode TEXT,
                    blocks_json TEXT,
                    client_event_id TEXT,
                    server_message_id TEXT,
                    task_id TEXT,
                    status TEXT NOT NULL,
                    attempt_count INTEGER NOT NULL,
                    last_error TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            db.execSQL(
                "CREATE INDEX IF NOT EXISTS index_queued_outgoing_messages_session_id_created_at " +
                    "ON queued_outgoing_messages (session_id, created_at)",
            )
            db.execSQL(
                "INSERT INTO queued_outgoing_messages " +
                    "(id, session_id, text, agent_mode, status, attempt_count, created_at, updated_at) " +
                    "VALUES ('legacy-id', 'session-1', 'hello', 'agent', 'WAITING', 0, 1, 1)",
            )
            db.version = 2
        }

        val room = Room.databaseBuilder(context, OutgoingMessageQueueDatabase::class.java, databaseName)
            .addMigrations(MIGRATION_2_3, MIGRATION_3_4)
            .allowMainThreadQueries()
            .build()
        try {
            val row = room.queuedOutgoingMessageDao().let { dao ->
                kotlinx.coroutines.runBlocking { dao.find("legacy-id") }
            }
            assertEquals("legacy-id", row?.id)
            assertEquals("agent", row?.agentMode)
            assertNull(row?.approvalMode)
            assertNull(row?.focusJson)
        } finally {
            room.close()
        }
    }

    @Test
    fun `migration 3 to 4 preserves rows and adds nullable focus json`() {
        SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(databaseName), null).use { db ->
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS queued_outgoing_messages (
                    id TEXT NOT NULL PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    text TEXT NOT NULL,
                    model_id TEXT,
                    agent_mode TEXT,
                    approval_mode TEXT,
                    blocks_json TEXT,
                    client_event_id TEXT,
                    server_message_id TEXT,
                    task_id TEXT,
                    status TEXT NOT NULL,
                    attempt_count INTEGER NOT NULL,
                    last_error TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            db.execSQL(
                "CREATE INDEX IF NOT EXISTS index_queued_outgoing_messages_session_id_created_at " +
                    "ON queued_outgoing_messages (session_id, created_at)",
            )
            db.execSQL(
                "INSERT INTO queued_outgoing_messages " +
                    "(id, session_id, text, agent_mode, approval_mode, status, attempt_count, created_at, updated_at) " +
                    "VALUES ('legacy-id', 'session-1', 'hello', 'agent', 'auto', 'WAITING', 0, 1, 1)",
            )
            db.version = 3
        }

        val room = Room.databaseBuilder(context, OutgoingMessageQueueDatabase::class.java, databaseName)
            .addMigrations(MIGRATION_3_4)
            .allowMainThreadQueries()
            .build()
        try {
            val row = room.queuedOutgoingMessageDao().let { dao ->
                kotlinx.coroutines.runBlocking { dao.find("legacy-id") }
            }
            assertEquals("legacy-id", row?.id)
            assertEquals("auto", row?.approvalMode)
            assertNull(row?.focusJson)
        } finally {
            room.close()
        }
    }
}

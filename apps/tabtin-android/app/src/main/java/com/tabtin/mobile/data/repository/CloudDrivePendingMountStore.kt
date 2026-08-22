package com.tabtin.mobile.data.repository

import android.content.Context
import android.content.SharedPreferences
import com.tabtin.mobile.data.model.files.CloudDrivePendingMountTask
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * 持久化 OSS confirm 成功但云盘 mount 失败的任务。
 * 使用 [SharedPreferences.commit] 同步落盘，避免进程被杀丢失。
 */
@Singleton
public class CloudDrivePendingMountStore @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    public fun list(): List<CloudDrivePendingMountTask> {
        val raw = prefs.getString(KEY_TASKS, null) ?: return emptyList()
        return runCatching {
            json.decodeFromString(ListSerializer(CloudDrivePendingMountTask.serializer()), raw)
        }.getOrDefault(emptyList())
    }

    public fun upsert(task: CloudDrivePendingMountTask) {
        val next = list()
            .filterNot {
                it.organizationId == task.organizationId && it.fileRecordId == task.fileRecordId
            } + task
        persist(next)
    }

    public fun remove(organizationId: String, fileRecordId: String) {
        persist(
            list().filterNot {
                it.organizationId == organizationId && it.fileRecordId == fileRecordId
            },
        )
    }

    public fun count(): Int = list().size

    private fun persist(tasks: List<CloudDrivePendingMountTask>) {
        val encoded = json.encodeToString(
            ListSerializer(CloudDrivePendingMountTask.serializer()),
            tasks,
        )
        prefs.edit().putString(KEY_TASKS, encoded).commit()
    }

    private companion object {
        const val PREFS_NAME: String = "tabtin_cloud_drive_pending_mount"
        const val KEY_TASKS: String = "tasks"
    }
}

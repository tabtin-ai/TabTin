package com.tabtin.mobile.features.profile

import android.content.Context
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.tabtin.mobile.R

/**
 * 会话级 AI 音频/转写共享同意。拒绝时不得启动 ASR；首次同意后需用户重新按住。
 */
public object AIDataSharingConsentStore {
    public const val CONSENT_VERSION: Int = 1
    private const val PREFS = "tabtin_ai_data_sharing_consent"
    private const val KEY_VERSION = "granted_version"

    public fun hasGranted(context: Context, version: Int = CONSENT_VERSION): Boolean {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return prefs.getInt(KEY_VERSION, 0) >= version
    }

    public fun grant(context: Context, version: Int = CONSENT_VERSION) {
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putInt(KEY_VERSION, version)
            .apply()
    }

    public fun revoke(context: Context) {
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_VERSION)
            .apply()
    }
}

@Composable
public fun AIDataSharingConsentDialog(
    onAgree: () -> Unit,
    onDisagree: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDisagree,
        title = { Text(stringResource(R.string.ai_data_sharing_consent_title)) },
        text = { Text(stringResource(R.string.ai_data_sharing_consent_message)) },
        confirmButton = {
            TextButton(onClick = onAgree) {
                Text(stringResource(R.string.ai_data_sharing_consent_agree))
            }
        },
        dismissButton = {
            TextButton(onClick = onDisagree) {
                Text(stringResource(R.string.ai_data_sharing_consent_disagree))
            }
        },
    )
}

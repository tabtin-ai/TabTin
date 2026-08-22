package com.tabtin.mobile.features.profile

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import com.tabtin.mobile.ui.components.IdentityColorAvatar
import com.tabtin.mobile.ui.theme.IdentityAvatar
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTSpacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun ProfileEditScreen(
    onBack: () -> Unit,
    viewModel: ProfileViewModel = hiltViewModel(),
) {
    val profile = viewModel.profileState
    val context = LocalContext.current
    val saveFailedMessage = stringResource(R.string.profile_edit_save_failed)
    var nickname by rememberSaveable { mutableStateOf("") }
    var username by rememberSaveable { mutableStateOf("") }
    var bio by rememberSaveable { mutableStateOf("") }
    var isSaving by remember { mutableStateOf(false) }
    var isUploadingAvatar by remember { mutableStateOf(false) }
    var hasSynced by remember { mutableStateOf(false) }

    val avatarPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        if (uri != null) {
            isUploadingAvatar = true
            viewModel.uploadAvatar(uri, context.contentResolver) { success, msg ->
                isUploadingAvatar = false
                if (!success) {
                    Toast.makeText(context, msg ?: "Upload failed", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    LaunchedEffect(profile) {
        if (!hasSynced && (profile.nickname != null || profile.username != null || profile.bio != null)) {
            nickname = profile.nickname ?: ""
            username = profile.username ?: ""
            bio = profile.bio ?: ""
            hasSynced = true
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.profile_edit_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = TTSpacing.xl),
        ) {
            Spacer(Modifier.height(TTSpacing.lg))

            Box(
                modifier = Modifier.fillMaxWidth(),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier
                        .size(80.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .clickable(enabled = !isUploadingAvatar) {
                            avatarPicker.launch(
                                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                            )
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    IdentityColorAvatar(
                        name = profile.nickname?.takeIf { it.isNotBlank() }
                            ?: stringResource(R.string.profile_default_name),
                        seed = IdentityAvatar.colorSeed(
                            profile.userId,
                            profile.nickname,
                        ),
                        imageUrl = profile.avatar,
                        size = 80.dp,
                    )
                    if (isUploadingAvatar) {
                        CircularProgressIndicator(modifier = Modifier.size(32.dp), strokeWidth = 3.dp)
                    }
                }
            }

            Spacer(Modifier.height(TTSpacing.xs))

            Text(
                stringResource(R.string.profile_tap_to_change_avatar),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth(),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )

            Spacer(Modifier.height(TTSpacing.lg))

            OutlinedTextField(
                value = nickname,
                onValueChange = { nickname = it },
                label = { Text(stringResource(R.string.profile_edit_nickname)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
            )

            Spacer(Modifier.height(TTSpacing.lg))

            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                label = { Text(stringResource(R.string.profile_edit_username)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
            )

            Spacer(Modifier.height(TTSpacing.lg))

            OutlinedTextField(
                value = bio,
                onValueChange = { bio = it },
                label = { Text(stringResource(R.string.profile_edit_bio)) },
                minLines = 3,
                maxLines = 5,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
            )

            Spacer(Modifier.height(TTSpacing.xxxl))

            Button(
                onClick = {
                    isSaving = true
                    viewModel.updateProfile(
                        nickname = nickname.ifBlank { null },
                        username = username.ifBlank { null },
                        bio = bio.ifBlank { null },
                    ) { success, errorMsg ->
                        isSaving = false
                        if (success) {
                            onBack()
                        } else {
                            Toast.makeText(
                                context,
                                errorMsg ?: saveFailedMessage,
                                Toast.LENGTH_SHORT,
                            ).show()
                        }
                    }
                },
                enabled = !isSaving,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(50.dp),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text(
                    text = if (isSaving) stringResource(R.string.profile_edit_saving)
                    else stringResource(R.string.profile_edit_save),
                    style = MaterialTheme.typography.bodyLarge,
                )
            }

            Spacer(Modifier.height(TTSpacing.huge))
        }
    }
}

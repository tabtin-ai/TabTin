package com.tabtin.mobile.features.doc.comment

import android.view.ViewTreeObserver
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTTextField
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.delay

@Composable
public fun DocCommentSection(
    presentations: List<DocCommentPresentation>,
    draft: String,
    canCreate: Boolean,
    isPosting: Boolean,
    onDraftChange: (String) -> Unit,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val hostView = LocalView.current
    var inputFocused by remember { mutableStateOf(false) }
    val imeBottomPx = rememberRootImeBottomPx()
    val liftPx = DocCommentImePolicy.liftBottomPx(inputFocused, imeBottomPx)

    LaunchedEffect(inputFocused, liftPx) {
        if (!inputFocused || liftPx <= 0) return@LaunchedEffect
        delay(32)
        DocCommentImePolicy.revealComposerAboveIme(hostView)
        delay(200)
        if (inputFocused) {
            DocCommentImePolicy.revealComposerAboveIme(hostView)
        }
    }

    Surface(
        modifier = modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surface,
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            HorizontalDivider()
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                Text(
                    text = stringResource(R.string.doc_comments_title),
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                if (presentations.isEmpty()) {
                    Text(
                        text = stringResource(R.string.doc_comment_empty),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    presentations.forEach { item ->
                        DocCommentCard(item)
                    }
                }
                if (canCreate) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        TTTextField(
                            value = draft,
                            onValueChange = onDraftChange,
                            modifier = Modifier
                                .weight(1f)
                                .onFocusChanged { inputFocused = it.isFocused },
                            placeholder = stringResource(R.string.doc_comment_placeholder),
                            enabled = !isPosting,
                            singleLine = true,
                        )
                        IconButton(
                            onClick = onSubmit,
                            enabled = canCreate && !isPosting && draft.isNotBlank(),
                        ) {
                            Icon(
                                Icons.AutoMirrored.Filled.Send,
                                contentDescription = stringResource(R.string.doc_comment_send),
                                tint = commentSendTint(),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun rememberRootImeBottomPx(): Int {
    val view = LocalView.current
    var bottomPx by remember { mutableIntStateOf(DocCommentImePolicy.readRootImeBottomPx(view)) }
    DisposableEffect(view) {
        val listener = ViewTreeObserver.OnGlobalLayoutListener {
            bottomPx = DocCommentImePolicy.readRootImeBottomPx(view)
        }
        view.viewTreeObserver.addOnGlobalLayoutListener(listener)
        listener.onGlobalLayout()
        onDispose {
            view.viewTreeObserver.removeOnGlobalLayoutListener(listener)
        }
    }
    return bottomPx
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun DocBlockCommentComposerSheet(
    draft: String,
    isPosting: Boolean,
    onDraftChange: (String) -> Unit,
    onSubmit: () -> Unit,
    onDismiss: () -> Unit,
) {
    TTBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
        ) {
            Text(
                text = stringResource(R.string.doc_comment_block_composer_title),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(bottom = 12.dp),
            )
            TTTextField(
                value = draft,
                onValueChange = onDraftChange,
                placeholder = stringResource(R.string.doc_comment_placeholder),
                enabled = !isPosting,
                singleLine = false,
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
            ) {
                IconButton(
                    onClick = onSubmit,
                    enabled = !isPosting && draft.isNotBlank(),
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.Send,
                        contentDescription = stringResource(R.string.doc_comment_send),
                        tint = commentSendTint(),
                    )
                }
            }
        }
    }
}

@Composable
private fun commentSendTint() =
    ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent)

@Composable
private fun DocCommentCard(item: DocCommentPresentation) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = TTRadius.Shapes.md,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            TTAvatar(
                name = item.authorName,
                imageUrl = item.authorAvatarUrl,
                size = 32.dp,
                shape = CircleShape,
            )
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                if (item.title.isNotBlank()) {
                    Text(
                        text = item.title,
                        style = MaterialTheme.typography.labelMedium,
                        color = when (item.kind) {
                            DocCommentAnchorKind.ORPHANED -> MaterialTheme.colorScheme.error
                            else -> MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                }
                Text(
                    text = item.authorName,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = item.body,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}

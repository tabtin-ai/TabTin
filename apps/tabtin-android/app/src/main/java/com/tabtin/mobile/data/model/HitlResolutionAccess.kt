package com.tabtin.mobile.data.model

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * Product-level permission for resolving a pending human-in-the-loop request.
 *
 * Personal and legacy payloads omit `team_space_execution` and remain unrestricted. Once a
 * payload declares team execution, only its execution owner may resolve it. Malformed metadata
 * fails closed so a relay/enrichment failure cannot reveal or enable a team request.
 */
public class HitlResolutionAccess private constructor(
    public val canResolve: Boolean,
    public val executionOwnerDisplayName: String?,
    private val metadataState: MetadataState,
) {
    public fun merging(incoming: HitlResolutionAccess): HitlResolutionAccess {
        if (incoming.metadataState.rank > metadataState.rank) return incoming
        if (incoming.metadataState.rank < metadataState.rank) return this
        if (metadataState != MetadataState.VALID) return this
        return HitlResolutionAccess(
            canResolve = canResolve && incoming.canResolve,
            executionOwnerDisplayName = incoming.executionOwnerDisplayName
                ?: executionOwnerDisplayName,
            metadataState = MetadataState.VALID,
        )
    }

    public companion object {
        public val Unrestricted: HitlResolutionAccess = HitlResolutionAccess(
            canResolve = true,
            executionOwnerDisplayName = null,
            metadataState = MetadataState.MISSING,
        )

        public fun resolve(payload: JsonObject, currentUserId: String?): HitlResolutionAccess {
            if (!payload.containsKey(TEAM_EXECUTION_KEY)) {
                val detailsRedacted = (payload[DETAILS_REDACTED_KEY] as? JsonPrimitive)
                    ?.booleanOrNull == true
                return if (payload.containsKey(REDACTION_REQUIRED_KEY) || detailsRedacted) {
                    invalid()
                } else {
                    Unrestricted
                }
            }

            val metadata = payload[TEAM_EXECUTION_KEY] as? JsonObject ?: return invalid()
            val ownerId = metadata.nonBlankString(EXECUTION_OWNER_ID_KEY) ?: return invalid()
            val normalizedCurrentUserId = currentUserId?.trim()?.takeIf { it.isNotEmpty() }
            return HitlResolutionAccess(
                canResolve = normalizedCurrentUserId == ownerId,
                executionOwnerDisplayName = metadata.nonBlankString(EXECUTION_OWNER_NAME_KEY),
                metadataState = MetadataState.VALID,
            )
        }

        private fun invalid(): HitlResolutionAccess = HitlResolutionAccess(
            canResolve = false,
            executionOwnerDisplayName = null,
            metadataState = MetadataState.INVALID,
        )
    }

    private enum class MetadataState(public val rank: Int) {
        MISSING(0),
        INVALID(1),
        VALID(2),
    }
}

private fun JsonObject.nonBlankString(key: String): String? =
    (this[key] as? JsonPrimitive)
        ?.contentOrNull
        ?.trim()
        ?.takeIf { it.isNotEmpty() }

private const val TEAM_EXECUTION_KEY = "team_space_execution"
private const val EXECUTION_OWNER_ID_KEY = "execution_owner_user_id"
private const val EXECUTION_OWNER_NAME_KEY = "execution_owner_display_name"
private const val REDACTION_REQUIRED_KEY = "__team_space_execution_redaction_required"
private const val DETAILS_REDACTED_KEY = "details_redacted"

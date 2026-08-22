package com.tabtin.mobile.data.im

public data class ImHumanReadReceiptProjection(
    val progress: ImReadReceipt?,
    val detail: ImMessageReadReceipts?,
)

/** Django 回执使用领域 user_id；客户端只需排除发送者、本人和 Agent。 */
public object ImHumanReadReceiptPolicy {
    public fun project(
        progress: ImReadReceipt?,
        detail: ImMessageReadReceipts?,
        members: List<ImMember>,
        currentUserId: String?,
        senderId: String,
    ): ImHumanReadReceiptProjection {
        val currentUserId = currentUserId.normalizedOrNull()
        val senderId = senderId.trim()
        val excludedActorIds = setOfNotNull(currentUserId, senderId.normalizedOrNull())
        val humanMemberIds = mutableSetOf<String>()
        val agentMemberIds = mutableSetOf<String>()
        members.forEach { member ->
            if (member.isAgent) {
                agentMemberIds += listOfNotNull(
                    member.userId.normalizedOrNull(),
                    member.agentId.normalizedOrNull(),
                )
            } else {
                member.userId.normalizedOrNull()?.let { userId ->
                    if (userId !in excludedActorIds) humanMemberIds += userId
                }
            }
        }
        val hasMemberSnapshot = members.isNotEmpty()

        fun isHumanRecipient(rawUserId: String): Boolean {
            val userId = rawUserId.trim()
            if (userId.isEmpty() || userId in excludedActorIds) return false
            if (userId in agentMemberIds) return false
            if (userId in humanMemberIds) return true
            return false
        }

        val projectedDetail = detail?.let {
            ImMessageReadReceipts(
                readers = it.readers.filter { member -> isHumanRecipient(member.userId) },
                unreaders = it.unreaders.filter { member -> isHumanRecipient(member.userId) },
            )
        }
        val rawRecipientCount = progress?.recipientCount?.coerceAtLeast(0) ?: 0
        val rawDetailCount = detail?.let { it.readers.size + it.unreaders.size } ?: 0
        val hasCompleteDetail = detail != null && rawRecipientCount > 0 && rawDetailCount >= rawRecipientCount

        val recipientCount: Int
        val readCount: Int
        if (hasCompleteDetail && projectedDetail != null) {
            readCount = projectedDetail.readers.size
            recipientCount = readCount + projectedDetail.unreaders.size
        } else {
            // 没有可信成员快照时无法判定哪些身份是 Agent；宁可暂不展示，
            // 也不能把原始人数当作真人口径。
            recipientCount = if (hasMemberSnapshot) {
                minOf(rawRecipientCount, humanMemberIds.size)
            } else 0
            // 汇总只有人数时没有读者身份；部分名单也不能把未返回身份的 reader 当真人。
            readCount = (projectedDetail?.readers?.size ?: 0).coerceAtMost(recipientCount)
        }

        return ImHumanReadReceiptProjection(
            progress = if (recipientCount > 0) ImReadReceipt(readCount, recipientCount) else null,
            detail = projectedDetail,
        )
    }

    private fun String?.normalizedOrNull(): String? = this?.trim()?.takeIf { it.isNotEmpty() }
}

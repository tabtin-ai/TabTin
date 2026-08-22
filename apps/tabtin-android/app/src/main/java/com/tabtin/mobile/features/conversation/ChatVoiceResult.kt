package com.tabtin.mobile.features.conversation

internal sealed class ChatVoiceResult {
    public data class FillDraft(val text: String) : ChatVoiceResult()
    public data class SendDirectly(val text: String) : ChatVoiceResult()
    public data object Cancelled : ChatVoiceResult()
}

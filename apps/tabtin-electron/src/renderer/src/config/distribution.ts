/** Build-time product boundary. Official/SaaS behavior remains the default. */
export const isCommunityDistribution =
  import.meta.env.VITE_DISTRIBUTION_KIND === 'community'

export const noChatModelDisabledReason = isCommunityDistribution
  ? 'community_no_chat_model'
  : 'no_chat_model'

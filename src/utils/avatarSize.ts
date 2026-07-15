export type FollowerInfo = {
  followers: number;
  source: "profile" | "twitterProfile" | "followers_count" | "none" | string;
};

/**
 * Follower count used for proportional avatar sizing.
 * Known counts (including explicit zero) are honored; only missing data falls back.
 */
export function followersForAvatarSize(
  followerInfo: FollowerInfo,
  hasSeedStance: boolean
): number {
  if (followerInfo.source !== "none") {
    return Math.max(0, followerInfo.followers);
  }
  return hasSeedStance ? 5000 : 0;
}

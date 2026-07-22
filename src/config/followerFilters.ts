/** Shared follower-category threshold for Options Plebs / Influencers filters. */
export const FOLLOWER_FILTER_THRESHOLD = 3000;

export function isPlebFollowerCount(followers: number): boolean {
  return Number.isFinite(followers) && followers < FOLLOWER_FILTER_THRESHOLD;
}

export function isInfluencerFollowerCount(followers: number): boolean {
  return Number.isFinite(followers) && followers >= FOLLOWER_FILTER_THRESHOLD;
}

const avatarCache = new Map<string, HTMLImageElement>();

export function getAvatar(src: string) {
  if (!avatarCache.has(src)) {
    const img = new Image();
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.src = src;
    avatarCache.set(src, img);
  }
  return avatarCache.get(src)!;
}

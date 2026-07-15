export function isFirefox(): boolean {
  if (typeof navigator === "undefined") return false;
  // Firefox UA contains "Firefox" and not "Seamonkey"
  return /Firefox\/\d+/.test(navigator.userAgent);
}

/** Chrome, Edge, Opera, Brave, and other Chromium shells — not Firefox or Safari. */
export function isChromium(): boolean {
  if (typeof navigator === "undefined") return false;
  if (isFirefox()) return false;

  const nav = navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string }> };
  };

  const brands = nav.userAgentData?.brands;
  if (Array.isArray(brands) && brands.length > 0) {
    return brands.some((b) =>
      /Chromium|Google Chrome|Microsoft Edge|Opera|Brave/i.test(b.brand)
    );
  }

  const ua = navigator.userAgent;
  if (/Safari/i.test(ua) && !/Chrom(e|ium)|Edg\//i.test(ua)) return false;
  return /Chrom(e|ium)|Edg\/|OPR\/|CriOS/i.test(ua);
}

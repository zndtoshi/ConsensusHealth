export function isFirefox(): boolean {
  if (typeof navigator === "undefined") return false;
  // Firefox UA contains "Firefox" and not "Seamonkey"
  return /Firefox\/\d+/.test(navigator.userAgent);
}

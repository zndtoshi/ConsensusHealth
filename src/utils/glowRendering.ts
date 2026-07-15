import { isChromium, isFirefox } from "./browser.js";

export const DEFAULT_GLOW_BLUR_MULTIPLIER = 1;
/** ~22% blur reduction for Chromium (within 20–30% target). */
export const CHROMIUM_GLOW_BLUR_MULTIPLIER = 0.78;
/** ~12% opacity reduction for Chromium (within 10–20% target). */
export const CHROMIUM_GLOW_OPACITY_MULTIPLIER = 0.88;
export const CHROMIUM_ZONE_ALPHA_MULTIPLIER = 0.9;

export type DebugGlowMode = "default" | "sharp";
export type GlowProfileId = "firefox" | "chromium-default" | "chromium-sharp" | "standard";

export type GlowProfile = {
  id: GlowProfileId;
  quality: number;
  blurMultiplier: number;
  opacityMultiplier: number;
  nonEmphasizedPasses: number;
  zoneAlphaMultiplier: number;
};

export type GlowSpriteOpts = {
  blurMultiplier?: number;
  opacityMultiplier?: number;
};

export function parseDebugGlowParams(search: string): DebugGlowMode | null {
  const v = new URLSearchParams(search).get("debugGlow");
  if (v === "default" || v === "sharp") return v;
  return null;
}

export function resolveGlowProfile(opts?: {
  isFirefox?: boolean;
  isChromium?: boolean;
  debugGlow?: DebugGlowMode | null;
}): GlowProfile {
  const ff = opts?.isFirefox ?? isFirefox();
  const cr = opts?.isChromium ?? isChromium();
  const debug = opts?.debugGlow ?? null;

  if (ff) {
    return {
      id: "firefox",
      quality: 0.48,
      blurMultiplier: DEFAULT_GLOW_BLUR_MULTIPLIER,
      opacityMultiplier: 1,
      nonEmphasizedPasses: 1,
      zoneAlphaMultiplier: 1,
    };
  }

  if (cr) {
    const useSharp = debug !== "default";
    if (useSharp) {
      return {
        id: "chromium-sharp",
        quality: 1,
        blurMultiplier: CHROMIUM_GLOW_BLUR_MULTIPLIER,
        opacityMultiplier: CHROMIUM_GLOW_OPACITY_MULTIPLIER,
        nonEmphasizedPasses: 1,
        zoneAlphaMultiplier: CHROMIUM_ZONE_ALPHA_MULTIPLIER,
      };
    }
    return {
      id: "chromium-default",
      quality: 1,
      blurMultiplier: DEFAULT_GLOW_BLUR_MULTIPLIER,
      opacityMultiplier: 1,
      nonEmphasizedPasses: 3,
      zoneAlphaMultiplier: 1,
    };
  }

  return {
    id: "standard",
    quality: 1,
    blurMultiplier: DEFAULT_GLOW_BLUR_MULTIPLIER,
    opacityMultiplier: 1,
    nonEmphasizedPasses: 3,
    zoneAlphaMultiplier: 1,
  };
}

export function scaleRgbaAlpha(color: string, multiplier: number): string {
  const m = String(color ?? "").match(/rgba\(\s*([^)]+)\)/i);
  if (!m) return color;
  const parts = m[1].split(",").map((s) => s.trim());
  if (parts.length < 4) return color;
  const a = Number.parseFloat(parts[3]);
  if (!Number.isFinite(a)) return color;
  parts[3] = String(Math.max(0, Math.min(1, a * multiplier)));
  return `rgba(${parts.join(", ")})`;
}

/**
 * Browser Canvas renderer for the admin halo avatar PNG.
 * Avatar fills the square edge-to-edge; stance ring sits against X's circular crop.
 */

export const HALO_AVATAR_OUTPUT_SIZE = 1024;

/** Ring stroke width at 1024×1024 (kept inside the circular X crop). */
export const HALO_AVATAR_RING_WIDTH = 20;

/**
 * Tiny inset so the full stroke stays inside the square / X circular crop.
 * Not padding around the avatar — the photo still fills the canvas.
 */
export const HALO_AVATAR_RING_SAFETY_INSET = 3;

/** Inward glow depth at 1024×1024; kept modest so the face stays clear. */
export const HALO_AVATAR_GLOW_PX = 36;

export type RenderHaloAvatarOptions = {
  image: CanvasImageSource;
  stanceColor: string;
  size?: number;
  glowPx?: number;
  ringWidth?: number;
  ringSafetyInset?: number;
};

export type HaloRingLayout = {
  size: number;
  cx: number;
  cy: number;
  /** Circular crop radius used for glow clip (canvas half-size). */
  cropRadius: number;
  ringWidth: number;
  /** Centerline radius of the stroke; stroke stays fully inside the canvas. */
  ringCenterRadius: number;
};

function parseHexRgb(color: string): { r: number; g: number; b: number } {
  const hex = String(color ?? "").trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 156, g: 163, b: 175 };
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function sourceSize(image: CanvasImageSource): { w: number; h: number } {
  if (typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement) {
    return {
      w: image.naturalWidth || image.width || 1,
      h: image.naturalHeight || image.height || 1,
    };
  }
  if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
    return { w: image.width || 1, h: image.height || 1 };
  }
  if (typeof HTMLCanvasElement !== "undefined" && image instanceof HTMLCanvasElement) {
    return { w: image.width || 1, h: image.height || 1 };
  }
  const anyImg = image as {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
  };
  return {
    w: Math.max(1, Number(anyImg.naturalWidth || anyImg.width) || 1),
    h: Math.max(1, Number(anyImg.naturalHeight || anyImg.height) || 1),
  };
}

/**
 * Center-crop / cover into a destination square.
 * scale = max(dest/srcW, dest/srcH); overflow is cropped, never letterboxed.
 */
export function coverDrawRect(
  srcW: number,
  srcH: number,
  destSize: number
): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } {
  const sw0 = Math.max(1, srcW);
  const sh0 = Math.max(1, srcH);
  const scale = Math.max(destSize / sw0, destSize / sh0);
  const dw = sw0 * scale;
  const dh = sh0 * scale;
  return {
    sx: 0,
    sy: 0,
    sw: sw0,
    sh: sh0,
    dx: (destSize - dw) / 2,
    dy: (destSize - dh) / 2,
    dw,
    dh,
  };
}

/** Geometry for the stance ring flush with X's circular crop edge. */
export function haloRingLayout(opts?: {
  size?: number;
  ringWidth?: number;
  ringSafetyInset?: number;
}): HaloRingLayout {
  const size = opts?.size ?? HALO_AVATAR_OUTPUT_SIZE;
  const ringWidth = opts?.ringWidth ?? HALO_AVATAR_RING_WIDTH;
  const ringSafetyInset = opts?.ringSafetyInset ?? HALO_AVATAR_RING_SAFETY_INSET;
  const cx = size / 2;
  const cy = size / 2;
  const cropRadius = size / 2;
  // radius = halfSize - lineWidth/2 - safety inset
  const ringCenterRadius = Math.max(1, cropRadius - ringWidth / 2 - ringSafetyInset);
  return { size, cx, cy, cropRadius, ringWidth, ringCenterRadius };
}

export function drawHaloAvatar(
  ctx: CanvasRenderingContext2D,
  opts: RenderHaloAvatarOptions
): void {
  const size = opts.size ?? HALO_AVATAR_OUTPUT_SIZE;
  const glowPx = opts.glowPx ?? HALO_AVATAR_GLOW_PX;
  const layout = haloRingLayout({
    size,
    ringWidth: opts.ringWidth,
    ringSafetyInset: opts.ringSafetyInset,
  });
  const { cx, cy, cropRadius, ringWidth, ringCenterRadius } = layout;
  const { r, g, b } = parseHexRgb(opts.stanceColor);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) {
    (ctx as CanvasRenderingContext2D & { imageSmoothingQuality: string }).imageSmoothingQuality =
      "high";
  }

  // Fill the entire square edge-to-edge (cover crop). No outer padding.
  const { w: srcW, h: srcH } = sourceSize(opts.image);
  const cover = coverDrawRect(srcW, srcH, size);
  ctx.drawImage(
    opts.image,
    cover.sx,
    cover.sy,
    cover.sw,
    cover.sh,
    cover.dx,
    cover.dy,
    cover.dw,
    cover.dh
  );

  // Inward glow only, clipped to the circular X crop area.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, cropRadius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  const inner = Math.max(0, cropRadius - glowPx);
  const glow = ctx.createRadialGradient(cx, cy, inner, cx, cy, cropRadius);
  glow.addColorStop(0, `rgba(${r},${g},${b},0)`);
  glow.addColorStop(0.45, `rgba(${r},${g},${b},0.04)`);
  glow.addColorStop(0.75, `rgba(${r},${g},${b},0.16)`);
  glow.addColorStop(0.9, `rgba(${r},${g},${b},0.32)`);
  glow.addColorStop(1, `rgba(${r},${g},${b},0.48)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, cropRadius, 0, Math.PI * 2);
  ctx.fill();

  // Soft layered strokes feather glow inward from the ring (face stays clear).
  const glowSteps = 10;
  for (let i = glowSteps; i >= 1; i -= 1) {
    const t = i / glowSteps;
    const strokeR = Math.max(2, ringCenterRadius - glowPx * t);
    const alpha = 0.28 * (1 - t) * (1 - t);
    if (alpha < 0.015) continue;
    ctx.beginPath();
    ctx.arc(cx, cy, strokeR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    ctx.lineWidth = Math.max(2, 8 * (1 - t) + 2);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }
  ctx.restore();

  // Crisp stance ring flush with the circular crop (fully inside canvas bounds).
  ctx.beginPath();
  ctx.arc(cx, cy, ringCenterRadius, 0, Math.PI * 2);
  ctx.strokeStyle = `rgb(${r},${g},${b})`;
  ctx.lineWidth = ringWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.restore();
}

export async function renderHaloAvatarPngBlob(
  opts: RenderHaloAvatarOptions
): Promise<Blob> {
  const size = opts.size ?? HALO_AVATAR_OUTPUT_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");
  drawHaloAvatar(ctx, opts);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/png");
  });
  if (!blob) throw new Error("Failed to export PNG from canvas.");
  return blob;
}

export function loadHaloAvatarImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Same-origin / proxy URLs stay untainted; avoid anonymous for blob: URLs.
    if (/^https?:\/\//i.test(url) && typeof window !== "undefined") {
      try {
        const abs = new URL(url, window.location.href);
        if (abs.origin !== window.location.origin) {
          img.crossOrigin = "anonymous";
        }
      } catch {
        // ignore
      }
    }
    img.decoding = "async";
    img.onload = () => {
      if (!img.naturalWidth) {
        reject(new Error("Avatar image loaded without dimensions."));
        return;
      }
      resolve(img);
    };
    img.onerror = () => reject(new Error("Unable to load avatar image for halo export."));
    img.src = url;
  });
}

export function triggerHaloAvatarDownload(blob: Blob, filename: string): () => void {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Return cleanup so callers can revoke after the click settles.
  return () => URL.revokeObjectURL(objectUrl);
}

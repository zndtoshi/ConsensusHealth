/**
 * Browser Canvas renderer for the admin halo avatar PNG.
 * Glow is drawn inward over the circular avatar; crisp ring near the crop edge.
 */

export const HALO_AVATAR_OUTPUT_SIZE = 1024;

/** Margin from square edge so X's circular crop keeps the ring visible. */
export const HALO_AVATAR_EDGE_PAD = 56;

/** Inward glow depth at 1024×1024 (within 25–45 px guidance). */
export const HALO_AVATAR_GLOW_PX = 42;

export const HALO_AVATAR_RING_WIDTH = 12;

export type RenderHaloAvatarOptions = {
  image: CanvasImageSource;
  stanceColor: string;
  size?: number;
  edgePad?: number;
  glowPx?: number;
  ringWidth?: number;
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
  const anyImg = image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
  return {
    w: Math.max(1, Number(anyImg.naturalWidth || anyImg.width) || 1),
    h: Math.max(1, Number(anyImg.naturalHeight || anyImg.height) || 1),
  };
}

/** Center-crop / cover draw of the source into a destination square. */
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

export function drawHaloAvatar(
  ctx: CanvasRenderingContext2D,
  opts: RenderHaloAvatarOptions
): void {
  const size = opts.size ?? HALO_AVATAR_OUTPUT_SIZE;
  const edgePad = opts.edgePad ?? HALO_AVATAR_EDGE_PAD;
  const glowPx = opts.glowPx ?? HALO_AVATAR_GLOW_PX;
  const ringWidth = opts.ringWidth ?? HALO_AVATAR_RING_WIDTH;
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

  const cx = size / 2;
  const cy = size / 2;
  const radius = Math.max(8, size / 2 - edgePad);

  // Circular avatar with center-crop cover.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  const { w: srcW, h: srcH } = sourceSize(opts.image);
  const cover = coverDrawRect(srcW, srcH, radius * 2);
  // Map cover square onto the circle's bounding box.
  const boxX = cx - radius;
  const boxY = cy - radius;
  ctx.drawImage(
    opts.image,
    cover.sx,
    cover.sy,
    cover.sw,
    cover.sh,
    boxX + cover.dx,
    boxY + cover.dy,
    cover.dw,
    cover.dh
  );

  // Inward glow over the avatar (transparent center → stance color near rim).
  const inner = Math.max(0, radius - glowPx);
  const glow = ctx.createRadialGradient(cx, cy, inner, cx, cy, radius);
  glow.addColorStop(0, `rgba(${r},${g},${b},0)`);
  glow.addColorStop(0.4, `rgba(${r},${g},${b},0.1)`);
  glow.addColorStop(0.72, `rgba(${r},${g},${b},0.34)`);
  glow.addColorStop(1, `rgba(${r},${g},${b},0.62)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Crisp stance ring just inside the circular crop boundary.
  ctx.beginPath();
  ctx.arc(cx, cy, radius - ringWidth / 2, 0, Math.PI * 2);
  ctx.strokeStyle = `rgb(${r},${g},${b})`;
  ctx.lineWidth = ringWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();

  // Soft inner edge on the ring so it sits on the photo cleanly.
  ctx.beginPath();
  ctx.arc(cx, cy, radius - ringWidth - 1, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${r},${g},${b},0.4)`;
  ctx.lineWidth = 2.5;
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

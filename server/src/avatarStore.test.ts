import assert from "node:assert/strict";
import { test } from "node:test";
import {
  avatarDownloadUrl,
  createAvatarProvisioner,
  fetchValidatedAvatarImage,
  highestQualityAvatarUrl,
  normalizeAvatarMimeType,
  resolveAvatarHttpResponse,
  AVATAR_DOWNLOAD_SIZE,
  MAX_AVATAR_BYTES,
  type AvatarBlob,
  type AvatarBlobReader,
  type AvatarBlobStore,
  type AvatarImageFetcher,
  type AvatarImageResponse,
} from "./avatarStore.js";

/** In-memory blob store with ON CONFLICT DO NOTHING semantics for tests. */
function createFakeStore(seed?: Record<string, AvatarBlob>) {
  const map = new Map<string, AvatarBlob>(Object.entries(seed ?? {}));
  let inserts = 0;
  const store: AvatarBlobStore & { size: () => number; inserts: () => number; raw: () => Map<string, AvatarBlob> } = {
    async has(xUserId) {
      return map.has(xUserId);
    },
    async insertIfAbsent(xUserId, mimeType, bytes) {
      if (map.has(xUserId)) return false;
      map.set(xUserId, { mimeType, bytes });
      inserts += 1;
      return true;
    },
    size: () => map.size,
    inserts: () => inserts,
    raw: () => map,
  };
  return store;
}

function imageResponse(opts: {
  ok?: boolean;
  status?: number;
  contentType?: string | null;
  bytes?: Buffer;
}): AvatarImageResponse {
  const bytes = opts.bytes ?? Buffer.from([0xff, 0xd8, 0xff]);
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    contentType: opts.contentType === undefined ? "image/jpeg" : opts.contentType,
    arrayBuffer: async () => {
      const ab = new ArrayBuffer(bytes.length);
      new Uint8Array(ab).set(bytes);
      return ab;
    },
  };
}

test("normalizeAvatarMimeType accepts allowed types and rejects others", () => {
  assert.equal(normalizeAvatarMimeType("image/jpeg"), "image/jpeg");
  assert.equal(normalizeAvatarMimeType("image/PNG; charset=binary"), "image/png");
  assert.equal(normalizeAvatarMimeType("image/webp"), "image/webp");
  assert.equal(normalizeAvatarMimeType("image/gif"), "image/gif");
  assert.equal(normalizeAvatarMimeType("text/html"), null);
  assert.equal(normalizeAvatarMimeType("image/svg+xml"), null);
  assert.equal(normalizeAvatarMimeType(null), null);
});

test("highestQualityAvatarUrl strips X size suffixes", () => {
  assert.equal(
    highestQualityAvatarUrl("https://pbs.twimg.com/profile_images/1/abc_normal.jpg"),
    "https://pbs.twimg.com/profile_images/1/abc.jpg"
  );
  assert.equal(
    highestQualityAvatarUrl("https://pbs.twimg.com/profile_images/1/abc_400x400.png"),
    "https://pbs.twimg.com/profile_images/1/abc.png"
  );
  assert.equal(highestQualityAvatarUrl(""), null);
  assert.equal(highestQualityAvatarUrl(null), null);
});

test("first successful avatar insert stores the blob", async () => {
  const store = createFakeStore();
  const fetchImage: AvatarImageFetcher = async () => imageResponse({ contentType: "image/png", bytes: Buffer.from("png-bytes") });
  const provisioner = createAvatarProvisioner({ store, fetchImage });

  const result = await provisioner.ensure("111", "https://pbs.twimg.com/x_normal.png");

  assert.deepEqual(result, { status: "stored" });
  assert.equal(store.size(), 1);
  assert.equal(store.inserts(), 1);
  assert.deepEqual(store.raw().get("111")?.mimeType, "image/png");
});

test("no overwrite: a later login never replaces an existing avatar", async () => {
  const store = createFakeStore({ "111": { mimeType: "image/jpeg", bytes: Buffer.from("original") } });
  let fetchCalls = 0;
  const fetchImage: AvatarImageFetcher = async () => {
    fetchCalls += 1;
    return imageResponse({ contentType: "image/png", bytes: Buffer.from("replacement") });
  };
  const provisioner = createAvatarProvisioner({ store, fetchImage });

  const result = await provisioner.ensure("111", "https://pbs.twimg.com/x_normal.png");

  assert.deepEqual(result, { status: "exists" });
  assert.equal(fetchCalls, 0, "existing avatar must not trigger a network fetch");
  assert.equal(store.inserts(), 0);
  assert.deepEqual(store.raw().get("111")?.bytes.toString(), "original");
});

test("retry after a failed fetch: a later processing attempt stores the avatar", async () => {
  const store = createFakeStore();
  let attempt = 0;
  const fetchImage: AvatarImageFetcher = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("network down");
    return imageResponse({ contentType: "image/jpeg", bytes: Buffer.from("later") });
  };
  const provisioner = createAvatarProvisioner({ store, fetchImage });

  const first = await provisioner.ensure("222", "https://pbs.twimg.com/x_normal.jpg");
  assert.deepEqual(first, { status: "failed", reason: "fetch_error" });
  assert.equal(store.size(), 0, "failed fetch must leave the avatar missing");

  const second = await provisioner.ensure("222", "https://pbs.twimg.com/x_normal.jpg");
  assert.deepEqual(second, { status: "stored" });
  assert.equal(store.size(), 1);
});

test("invalid content type is rejected and nothing is stored", async () => {
  const store = createFakeStore();
  const fetchImage: AvatarImageFetcher = async () => imageResponse({ contentType: "text/html", bytes: Buffer.from("<html>") });
  const provisioner = createAvatarProvisioner({ store, fetchImage });

  const result = await provisioner.ensure("333", "https://pbs.twimg.com/x_normal.jpg");

  assert.deepEqual(result, { status: "failed", reason: "invalid_content_type" });
  assert.equal(store.size(), 0);
});

test("oversized responses are rejected", async () => {
  const store = createFakeStore();
  const big = Buffer.alloc(MAX_AVATAR_BYTES + 1, 0x41);
  const fetchImage: AvatarImageFetcher = async () => imageResponse({ contentType: "image/jpeg", bytes: big });
  const provisioner = createAvatarProvisioner({ store, fetchImage });

  const result = await provisioner.ensure("444", "https://pbs.twimg.com/x_normal.jpg");

  assert.deepEqual(result, { status: "failed", reason: "too_large" });
  assert.equal(store.size(), 0);
});

test("non-ok upstream status is rejected", async () => {
  const outcome = await fetchValidatedAvatarImage(
    "https://pbs.twimg.com/x.jpg",
    async () => imageResponse({ ok: false, status: 404 })
  );
  assert.deepEqual(outcome, { ok: false, reason: "bad_status" });
});

test("missing profile image URL is skipped, not failed", async () => {
  const store = createFakeStore();
  let fetchCalls = 0;
  const fetchImage: AvatarImageFetcher = async () => {
    fetchCalls += 1;
    return imageResponse({});
  };
  const provisioner = createAvatarProvisioner({ store, fetchImage });

  const result = await provisioner.ensure("555", null);

  assert.deepEqual(result, { status: "skipped_no_url" });
  assert.equal(fetchCalls, 0);
  assert.equal(store.size(), 0);
});

test("concurrent inserts for the same user fetch and insert exactly once", async () => {
  const store = createFakeStore();
  let fetchCalls = 0;
  const fetchImage: AvatarImageFetcher = async () => {
    fetchCalls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return imageResponse({ contentType: "image/jpeg", bytes: Buffer.from("concurrent") });
  };
  const provisioner = createAvatarProvisioner({ store, fetchImage });

  const [a, b] = await Promise.all([
    provisioner.ensure("666", "https://pbs.twimg.com/x_normal.jpg"),
    provisioner.ensure("666", "https://pbs.twimg.com/x_normal.jpg"),
  ]);

  assert.deepEqual(a, { status: "stored" });
  assert.deepEqual(b, { status: "stored" });
  assert.equal(fetchCalls, 1, "duplicate concurrent downloads must be prevented");
  assert.equal(store.inserts(), 1);
  assert.equal(store.size(), 1);
});

test("insertIfAbsent losing the race resolves to exists (cross-process safety)", async () => {
  // Store already populated by another process between has() and insert().
  const store: AvatarBlobStore = {
    async has() {
      return false;
    },
    async insertIfAbsent() {
      return false; // ON CONFLICT DO NOTHING affected 0 rows
    },
  };
  const fetchImage: AvatarImageFetcher = async () => imageResponse({ contentType: "image/jpeg" });
  const provisioner = createAvatarProvisioner({ store, fetchImage });

  const result = await provisioner.ensure("777", "https://pbs.twimg.com/x_normal.jpg");

  assert.deepEqual(result, { status: "exists" });
});

test("avatar route returns 200 with correct headers when the blob exists", async () => {
  const bytes = Buffer.from("image-data");
  const reader: AvatarBlobReader = {
    async get(xUserId) {
      return xUserId === "888" ? { mimeType: "image/webp", bytes } : null;
    },
  };

  const response = await resolveAvatarHttpResponse(reader, "888");

  assert.equal(response.status, 200);
  if (response.status === 200) {
    assert.equal(response.headers["Content-Type"], "image/webp");
    assert.equal(response.headers["Cache-Control"], "public, max-age=31536000, immutable");
    assert.equal(response.headers["Content-Length"], String(bytes.length));
    assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
    assert.match(response.headers.ETag, /^"[0-9a-f]{40}"$/);
    assert.deepEqual(response.body, bytes);
  }
});

test("avatar 304 response still carries immutable cache + nosniff headers", async () => {
  const bytes = Buffer.from("image-data");
  const reader: AvatarBlobReader = { async get() { return { mimeType: "image/jpeg", bytes }; } };
  const first = await resolveAvatarHttpResponse(reader, "888");
  const etag = first.status === 200 ? first.headers.ETag : "";
  const second = await resolveAvatarHttpResponse(reader, "888", etag);
  assert.equal(second.status, 304);
  if (second.status === 304) {
    assert.equal(second.headers["Cache-Control"], "public, max-age=31536000, immutable");
    assert.equal(second.headers["X-Content-Type-Options"], "nosniff");
  }
});

test("avatarDownloadUrl normalizes twimg URLs to a square variant", () => {
  assert.equal(AVATAR_DOWNLOAD_SIZE, 400);
  assert.equal(
    avatarDownloadUrl("https://pbs.twimg.com/profile_images/1/abc.jpg"),
    "https://pbs.twimg.com/profile_images/1/abc_400x400.jpg"
  );
  // Existing size suffixes are stripped to the base first, then normalized.
  assert.equal(
    avatarDownloadUrl("https://pbs.twimg.com/profile_images/1/abc_normal.jpg"),
    "https://pbs.twimg.com/profile_images/1/abc_400x400.jpg"
  );
  assert.equal(
    avatarDownloadUrl("https://pbs.twimg.com/profile_images/1/abc_200x200.jpg"),
    "https://pbs.twimg.com/profile_images/1/abc_400x400.jpg"
  );
  assert.equal(
    avatarDownloadUrl("https://pbs.twimg.com/profile_images/1/abc.jpg", 256),
    "https://pbs.twimg.com/profile_images/1/abc_256x256.jpg"
  );
});

test("avatarDownloadUrl leaves non-twimg hosts as the highest-quality original", () => {
  assert.equal(
    avatarDownloadUrl("https://example.com/pics/me_normal.png"),
    "https://example.com/pics/me.png"
  );
  assert.equal(avatarDownloadUrl(""), null);
  assert.equal(avatarDownloadUrl(null), null);
});

test("provisioner downloads and stores the normalized square variant", async () => {
  const store = createFakeStore();
  const requested: string[] = [];
  const fetchImage: AvatarImageFetcher = async (url) => {
    requested.push(url);
    return imageResponse({ ok: true, status: 200, contentType: "image/jpeg", bytes: Buffer.from("img") });
  };
  const provisioner = createAvatarProvisioner({ store, fetchImage });
  const result = await provisioner.ensure("42", "https://pbs.twimg.com/profile_images/9/z.jpg");
  assert.equal(result.status, "stored");
  assert.deepEqual(requested, ["https://pbs.twimg.com/profile_images/9/z_400x400.jpg"]);
});

test("avatar route returns 304 when If-None-Match matches", async () => {
  const bytes = Buffer.from("image-data");
  const reader: AvatarBlobReader = { async get() { return { mimeType: "image/jpeg", bytes }; } };
  const first = await resolveAvatarHttpResponse(reader, "888");
  assert.equal(first.status, 200);
  const etag = first.status === 200 ? first.headers.ETag : "";
  const second = await resolveAvatarHttpResponse(reader, "888", etag);
  assert.equal(second.status, 304);
});

test("avatar route returns 404 when no blob exists", async () => {
  const reader: AvatarBlobReader = { async get() { return null; } };
  const response = await resolveAvatarHttpResponse(reader, "999");
  assert.deepEqual(response, { status: 404 });
});

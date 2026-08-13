import { createHash } from "node:crypto";
import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type TestInfo,
} from "@playwright/test";

/** RFC 5737 TEST-NET ranges for documentation / lab traffic. */
const TEST_NET_PREFIXES = ["192.0.2", "198.51.100", "203.0.113"] as const;

const assignedClientIps = new Set<string>();

function allocateTestClientIp(stableKey: string): string {
  const digest = createHash("sha256").update(stableKey).digest();
  const start = digest.readUInt32BE(0) >>> 0;
  const span = 254 * TEST_NET_PREFIXES.length;
  for (let attempt = 0; attempt < span; attempt += 1) {
    const idx = (start + attempt) % span;
    const prefix = TEST_NET_PREFIXES[Math.floor(idx / 254)]!;
    const host = (idx % 254) + 1;
    const ip = `${prefix}.${host}`;
    if (!assignedClientIps.has(ip)) {
      assignedClientIps.add(ip);
      return ip;
    }
  }
  throw new Error("exhausted RFC 5737 TEST-NET client IPs for Playwright isolation");
}

function testIdentityKey(testInfo: TestInfo, role: "primary" | "secondary"): string {
  return [
    role,
    testInfo.file,
    String(testInfo.line),
    String(testInfo.column),
    testInfo.titlePath.join(">"),
    testInfo.project.name,
  ].join("\0");
}

/** Stable unique TEST-NET IPv4 for this test's default BrowserContext. */
export function deterministicTestClientIp(testInfo: TestInfo): string {
  return allocateTestClientIp(testIdentityKey(testInfo, "primary"));
}

/**
 * Stable second TEST-NET IPv4 for the same test (dual IP/account checks).
 * Guaranteed distinct from that test's primary allocation.
 */
export function alternateTestClientIp(testInfo: TestInfo): string {
  return allocateTestClientIp(testIdentityKey(testInfo, "secondary"));
}

export const CLIENT_IP_HEADER = "X-Forwarded-For";

/** Create a BrowserContext that presents a known client IP via trusted-proxy XFF. */
export async function newContextWithClientIp(
  browser: Browser,
  clientIp: string,
  options?: Parameters<Browser["newContext"]>[0]
): Promise<BrowserContext> {
  return browser.newContext({
    ...options,
    extraHTTPHeaders: {
      ...(options?.extraHTTPHeaders || {}),
      [CLIENT_IP_HEADER]: clientIp,
    },
  });
}

/**
 * Every test that hits the shared server gets a unique TEST-NET X-Forwarded-For
 * before requests begin. Express `trust proxy = 1` (render_direct) surfaces that
 * as req.ip for rate keys. Headers do not leak across tests (fresh context each).
 */
export const test = base.extend<{ testClientIp: string }>({
  testClientIp: async ({}, use, testInfo) => {
    await use(deterministicTestClientIp(testInfo));
  },
  context: async ({ context, testClientIp }, use) => {
    await context.setExtraHTTPHeaders({ [CLIENT_IP_HEADER]: testClientIp });
    await use(context);
  },
  request: async ({ playwright, testClientIp }, use, testInfo) => {
    const baseURL =
      typeof testInfo.project.use.baseURL === "string" ? testInfo.project.use.baseURL : undefined;
    const request = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { [CLIENT_IP_HEADER]: testClientIp },
    });
    try {
      await use(request);
    } finally {
      await request.dispose();
    }
  },
});

export { expect };

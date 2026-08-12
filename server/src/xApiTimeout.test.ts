import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchWithTimeout,
  fetchXTweetById,
  isXApiTimeoutError,
  XApiTimeoutError,
} from "./xApiUsers.js";

test("fetchWithTimeout aborts hung requests and cleans up", async () => {
  let sawAbort = false;
  await assert.rejects(
    () =>
      fetchWithTimeout(
        async (_url, init) => {
          await new Promise<void>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("should have aborted")), 500);
            init?.signal?.addEventListener(
              "abort",
              () => {
                sawAbort = true;
                clearTimeout(timer);
                reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
              },
              { once: true }
            );
          });
          return new Response("{}", { status: 200 });
        },
        "https://api.x.com/2/tweets/1",
        { headers: { accept: "application/json" } },
        25
      ),
    (err: unknown) => {
      assert.equal(isXApiTimeoutError(err), true);
      assert.ok(err instanceof XApiTimeoutError || isXApiTimeoutError(err));
      return true;
    }
  );
  assert.equal(sawAbort, true);
});

test("fetchXTweetById timeout does not return a tweet", async () => {
  await assert.rejects(
    () =>
      fetchXTweetById("bearer", "1", {
        timeoutMs: 20,
        fetchImpl: async (_url, init) => {
          await new Promise<void>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
              { once: true }
            );
          });
          return new Response("{}", { status: 200 });
        },
      }),
    (err: unknown) => isXApiTimeoutError(err)
  );
});

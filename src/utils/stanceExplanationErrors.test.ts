import test from "node:test";
import assert from "node:assert/strict";
import {
  PARTIAL_STANCE_EXPLANATION_STATUS,
  friendlyStanceExplanationError,
  STANCE_EXPLANATION_ERROR_COPY,
} from "./stanceExplanationErrors";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STANCE_EXPLANATION_USER_MESSAGES } from "../../server/src/stanceExplanations.ts";

test("friendlyStanceExplanationError never returns raw machine codes", () => {
  for (const code of Object.keys(STANCE_EXPLANATION_ERROR_COPY)) {
    const msg = friendlyStanceExplanationError({ error: code });
    assert.notEqual(msg, code);
    assert.equal(msg, STANCE_EXPLANATION_ERROR_COPY[code]);
    assert.doesNotMatch(msg, /verification_unavailable|tweet_author_mismatch|invalid_tweet_url/);
  }
  assert.equal(
    friendlyStanceExplanationError({
      error: "verification_unavailable",
      message: STANCE_EXPLANATION_ERROR_COPY.verification_unavailable,
    }),
    STANCE_EXPLANATION_ERROR_COPY.verification_unavailable
  );
});

test("server and frontend verification_unavailable copy stay aligned and avoid stance contradiction", () => {
  assert.equal(
    STANCE_EXPLANATION_ERROR_COPY.verification_unavailable,
    STANCE_EXPLANATION_USER_MESSAGES.verification_unavailable
  );
  assert.match(
    STANCE_EXPLANATION_ERROR_COPY.verification_unavailable,
    /explanation was not changed/i
  );
  assert.doesNotMatch(
    STANCE_EXPLANATION_ERROR_COPY.verification_unavailable,
    /position is unchanged/i
  );
});

test("verification failure without stance change discusses only the explanation", () => {
  const status = "";
  const error = friendlyStanceExplanationError({ error: "verification_unavailable" });
  const rendered = [status, error].filter(Boolean).join(" ");
  assert.match(rendered, /explanation was not changed/i);
  assert.doesNotMatch(rendered, /position is unchanged|Position saved/i);
});

test("stance-save success plus verification failure reports both facts without contradiction", () => {
  const status = PARTIAL_STANCE_EXPLANATION_STATUS;
  const error = friendlyStanceExplanationError({ error: "verification_unavailable" });
  const rendered = `${status} ${error}`;
  assert.match(rendered, /Position saved/i);
  assert.match(rendered, /explanation link was not accepted/i);
  assert.match(rendered, /explanation was not changed/i);
  assert.doesNotMatch(rendered, /position is unchanged/i);
});

test("App and StanceChoiceCard use friendly explanation errors and partial-success copy", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const appSrc = readFileSync(join(root, "App.jsx"), "utf8");
  const cardSrc = readFileSync(join(root, "components", "StanceChoiceCard.jsx"), "utf8");
  assert.match(appSrc, /friendlyStanceExplanationError/);
  assert.match(appSrc, /PARTIAL_STANCE_EXPLANATION_STATUS/);
  assert.match(appSrc, /stanceChoiceSession/);
  assert.doesNotMatch(cardSrc, /verification_unavailable/);
  // Partial status only when stance actually changed in the save flow.
  assert.match(appSrc, /stanceOk && !stanceFrozen && !stanceUnchanged/);
  assert.match(appSrc, /setStanceChoiceStatus\(PARTIAL_STANCE_EXPLANATION_STATUS\)/);
});

test("partial success status is distinct from verification error copy", () => {
  assert.match(PARTIAL_STANCE_EXPLANATION_STATUS, /Position saved/i);
  assert.notEqual(
    PARTIAL_STANCE_EXPLANATION_STATUS,
    STANCE_EXPLANATION_ERROR_COPY.verification_unavailable
  );
});

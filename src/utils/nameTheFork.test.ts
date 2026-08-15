import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearPendingNameTheForkVote,
  createCandidateVoteWriteGate,
  decidePendingNameTheForkVoteAction,
  friendlyNameTheForkError,
  isNameTheForkPath,
  NAME_THE_FORK_MAX_CHARS,
  NAME_THE_FORK_PATH,
  NAME_THE_FORK_THEME,
  NAME_THE_FORK_TITLE,
  NTF_PENDING_VOTE_KEY,
  normalizeCandidateName,
  graphemeLength,
  readPendingNameTheForkVote,
  runExclusiveCandidateVoteWrite,
  writePendingNameTheForkVote,
} from "./nameTheFork.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function installMemorySessionStorage() {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return store;
}

test("isNameTheForkPath recognizes only the hidden galaxy route", () => {
  assert.equal(isNameTheForkPath(NAME_THE_FORK_PATH), true);
  assert.equal(isNameTheForkPath("/name-the-fork/"), true);
  assert.equal(isNameTheForkPath("/"), false);
  assert.equal(isNameTheForkPath("/bip/54"), false);
});

test("display title is exact and client validation mirrors server", () => {
  assert.equal(NAME_THE_FORK_TITLE, "Name the PoW change fork");
  assert.equal(normalizeCandidateName("Bdash").ok, true);
  assert.equal(normalizeCandidateName("a".repeat(NAME_THE_FORK_MAX_CHARS + 1)).ok, false);
  assert.equal(normalizeCandidateName("@x").ok, false);
  assert.equal(graphemeLength("👨‍💻"), 1);
  assert.match(friendlyNameTheForkError("custom_already_submitted"), /already suggested/i);
  assert.match(friendlyNameTheForkError("candidate_not_votable"), /no longer available/i);
  assert.match(NAME_THE_FORK_THEME.accent, /#34d399/i);
});

test("pending vote intent helpers round-trip and clear", () => {
  const store = installMemorySessionStorage();
  writePendingNameTheForkVote("seed_bdash");
  assert.equal(store.get(NTF_PENDING_VOTE_KEY), "seed_bdash");
  assert.equal(readPendingNameTheForkVote(), "seed_bdash");
  clearPendingNameTheForkVote();
  assert.equal(readPendingNameTheForkVote(), null);
});

test("pending vote decision waits while login is in progress", () => {
  assert.equal(
    decidePendingNameTheForkVoteAction({
      pendingCandidateId: "seed_a",
      authenticated: false,
      authBusy: true,
      pollReady: true,
      castInFlight: false,
      approvedCandidateIds: ["seed_a"],
      selectedCandidateId: null,
    }).type,
    "wait"
  );
  assert.equal(
    decidePendingNameTheForkVoteAction({
      pendingCandidateId: "seed_a",
      authenticated: true,
      authBusy: true,
      pollReady: true,
      castInFlight: false,
      approvedCandidateIds: ["seed_a"],
      selectedCandidateId: null,
    }).type,
    "wait"
  );
});

test("pending vote decision clears unavailable candidate without cast", () => {
  assert.deepEqual(
    decidePendingNameTheForkVoteAction({
      pendingCandidateId: "gone",
      authenticated: true,
      authBusy: false,
      pollReady: true,
      castInFlight: false,
      approvedCandidateIds: ["seed_a"],
      selectedCandidateId: null,
    }),
    { type: "clear" }
  );
});

test("pending vote decision casts once and ignores duplicate consumed id", () => {
  const cast = decidePendingNameTheForkVoteAction({
    pendingCandidateId: "seed_a",
    authenticated: true,
    authBusy: false,
    pollReady: true,
    castInFlight: false,
    approvedCandidateIds: ["seed_a", "seed_b"],
    selectedCandidateId: null,
  });
  assert.deepEqual(cast, { type: "cast", candidateId: "seed_a", changing: false });

  const changing = decidePendingNameTheForkVoteAction({
    pendingCandidateId: "seed_b",
    authenticated: true,
    authBusy: false,
    pollReady: true,
    castInFlight: false,
    approvedCandidateIds: ["seed_a", "seed_b"],
    selectedCandidateId: "seed_a",
  });
  assert.deepEqual(changing, { type: "cast", candidateId: "seed_b", changing: true });

  assert.equal(
    decidePendingNameTheForkVoteAction({
      pendingCandidateId: "seed_a",
      authenticated: true,
      authBusy: false,
      pollReady: true,
      castInFlight: false,
      approvedCandidateIds: ["seed_a"],
      selectedCandidateId: null,
      consumedCandidateId: "seed_a",
    }).type,
    "wait"
  );
  assert.equal(
    decidePendingNameTheForkVoteAction({
      pendingCandidateId: "seed_a",
      authenticated: true,
      authBusy: false,
      pollReady: true,
      castInFlight: true,
      approvedCandidateIds: ["seed_a"],
      selectedCandidateId: null,
    }).type,
    "wait"
  );
  assert.deepEqual(
    decidePendingNameTheForkVoteAction({
      pendingCandidateId: "seed_a",
      authenticated: true,
      authBusy: false,
      pollReady: true,
      castInFlight: false,
      approvedCandidateIds: ["seed_a"],
      selectedCandidateId: "seed_a",
    }),
    { type: "already_selected", candidateId: "seed_a" }
  );
});

test("pending vote decision allows a second independent cycle after consume reset", () => {
  const first = decidePendingNameTheForkVoteAction({
    pendingCandidateId: "seed_a",
    authenticated: true,
    authBusy: false,
    pollReady: true,
    castInFlight: false,
    approvedCandidateIds: ["seed_a", "seed_b"],
    selectedCandidateId: null,
    consumedCandidateId: null,
  });
  assert.equal(first.type, "cast");

  // After logout + new anonymous click, consumed latch is cleared for a new id.
  const second = decidePendingNameTheForkVoteAction({
    pendingCandidateId: "seed_b",
    authenticated: true,
    authBusy: false,
    pollReady: true,
    castInFlight: false,
    approvedCandidateIds: ["seed_a", "seed_b"],
    selectedCandidateId: "seed_a",
    consumedCandidateId: null,
  });
  assert.deepEqual(second, { type: "cast", candidateId: "seed_b", changing: true });
});

test("exclusive candidate vote write starts exactly one request under overlapping clicks", async () => {
  const gate = createCandidateVoteWriteGate();
  const startedIds = [];
  const busyEvents = [];
  const successIds = [];
  const errorCodes = [];
  let resolveFirst;
  const firstWrite = () =>
    new Promise((resolve) => {
      startedIds.push("a");
      resolveFirst = resolve;
    });
  const secondWrite = () => {
    startedIds.push("b");
    return Promise.resolve({ id: "b" });
  };

  const first = runExclusiveCandidateVoteWrite({
    gate,
    write: firstWrite,
    onBusy: (b) => busyEvents.push(b),
    onSuccess: (v) => successIds.push(v.id),
    onError: (e) => errorCodes.push(e),
  });
  const second = runExclusiveCandidateVoteWrite({
    gate,
    write: secondWrite,
    onBusy: (b) => busyEvents.push(`second:${b}`),
    onSuccess: (v) => successIds.push(v.id),
    onError: (e) => errorCodes.push(e),
  });

  assert.equal(await second, "skipped");
  assert.deepEqual(startedIds, ["a"]);
  assert.deepEqual(busyEvents, [true]);
  assert.deepEqual(successIds, []);
  assert.deepEqual(errorCodes, []);
  assert.equal(gate.isHeld(), true);

  resolveFirst({ id: "a" });
  assert.equal(await first, "ok");
  assert.deepEqual(successIds, ["a"]);
  assert.deepEqual(busyEvents, [true, false]);
  assert.equal(gate.isHeld(), false);

  const third = await runExclusiveCandidateVoteWrite({
    gate,
    write: async () => {
      startedIds.push("c");
      return { id: "c" };
    },
    onBusy: (b) => busyEvents.push(b),
    onSuccess: (v) => successIds.push(v.id),
  });
  assert.equal(third, "ok");
  assert.deepEqual(startedIds, ["a", "c"]);
  assert.deepEqual(successIds, ["a", "c"]);
  assert.equal(gate.isHeld(), false);
});

test("App clears pending intent on auth failure, cancel, timeout, logout, and route exit", () => {
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  // Auth error message path
  assert.match(appSrc, /isAuthSuccessMessage[\s\S]*?clearPendingNameTheForkVote/);
  // Cancel/close without session after completeLogin loadMe
  assert.match(appSrc, /if \(!authenticated\) clearPendingNameTheForkVote\(\)/);
  // Popup timeout safety valve
  assert.match(appSrc, /5 \* 60 \* 1000[\s\S]*?clearPendingNameTheForkVote\(\)/);
  // Logout
  assert.match(appSrc, /async function logout\([\s\S]*?clearPendingNameTheForkVote/);
  // Leave /name-the-fork
  assert.match(appSrc, /returnFromNameTheFork[\s\S]*?clearPendingNameTheForkVote/);
  assert.match(appSrc, /clearPendingNameTheForkVote\(\);\s*\n\s*setShowNameTheFork\(false\)/);
});

test("galaxy pending lifecycle uses decision helper without permanent latch", () => {
  const galaxySrc = fs.readFileSync(path.join(here, "..", "components", "NameTheForkGalaxy.jsx"), "utf8");
  assert.match(galaxySrc, /decidePendingNameTheForkVoteAction/);
  assert.match(galaxySrc, /createCandidateVoteWriteGate/);
  assert.match(galaxySrc, /runExclusiveCandidateVoteWrite/);
  assert.match(galaxySrc, /candidateVoteGateRef/);
  assert.match(galaxySrc, /consumedPendingIdRef/);
  assert.doesNotMatch(galaxySrc, /pendingVoteHandledRef/);
  assert.match(galaxySrc, /consumedPendingIdRef\.current = null/);
  // Candidate votes use the exclusive gate; other writes keep runWrite.
  assert.match(galaxySrc, /executeCandidateVote/);
  assert.match(galaxySrc, /runWrite\(\(\) => deleteNameTheForkVote/);
  assert.match(galaxySrc, /runWrite\(\s*\(\) => postNameTheForkCandidate/);
  assert.match(galaxySrc, /runWrite\(\(\) => postNameTheForkHide/);
  assert.match(galaxySrc, /runWrite\(\(\) => postNameTheForkApprove/);
  assert.match(galaxySrc, /runWrite\(\(\) => postNameTheForkReject/);
});

test("discovery star has exactly four decorative rays and reduced-motion static class", () => {
  const starSrc = fs.readFileSync(path.join(here, "..", "components", "HiddenGalaxyStar.jsx"), "utf8");
  const cssSrc = fs.readFileSync(path.join(here, "..", "index.css"), "utf8");
  const rayMatches = starSrc.match(/hiddenGalaxyStar__ray--[nesw]/g) || [];
  assert.equal(rayMatches.length, 4);
  assert.deepEqual([...rayMatches].sort(), [
    "hiddenGalaxyStar__ray--e",
    "hiddenGalaxyStar__ray--n",
    "hiddenGalaxyStar__ray--s",
    "hiddenGalaxyStar__ray--w",
  ]);
  assert.match(starSrc, /is-static/);
  assert.match(starSrc, /reducedMotion/);
  assert.match(cssSrc, /\.hiddenGalaxyStar__ray[\s\S]*?pointer-events:\s*none/);
  assert.match(cssSrc, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.hiddenGalaxyStar/);
});

test("App mounts discovery star and one-click Name the PoW change fork UI", () => {
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  const starSrc = fs.readFileSync(path.join(here, "..", "components", "HiddenGalaxyStar.jsx"), "utf8");
  const galaxySrc = fs.readFileSync(path.join(here, "..", "components", "NameTheForkGalaxy.jsx"), "utf8");
  const cssSrc = fs.readFileSync(path.join(here, "..", "index.css"), "utf8");

  assert.match(appSrc, /HiddenGalaxyStar/);
  assert.match(appSrc, /travelToNameTheFork/);
  assert.match(appSrc, /NameTheForkGalaxy/);
  assert.match(appSrc, /showNameTheFork/);
  assert.match(appSrc, /NAME_THE_FORK_TITLE/);
  assert.match(appSrc, /clearPendingNameTheForkVote/);
  assert.match(appSrc, /Hidden galaxy/);
  assert.doesNotMatch(appSrc, />Easter egg</);
  assert.doesNotMatch(appSrc, /consensusOverviewHeader__title[\s\S]{0,80}Name the PoW change fork/);

  const stanceBranch = appSrc.indexOf("!stanceListsViewEnabled ?");
  const starMount = appSrc.indexOf("<HiddenGalaxyStar");
  assert.ok(stanceBranch >= 0 && starMount > stanceBranch, "star must mount after layout branch");

  assert.match(starSrc, /Discover a hidden galaxy/);
  assert.doesNotMatch(starSrc, /onKeyDown/);

  assert.match(galaxySrc, /NAME_THE_FORK_TITLE/);
  assert.match(galaxySrc, /Return to consensus/);
  assert.match(galaxySrc, /Suggest a name/);
  assert.match(galaxySrc, /Remove vote/);
  assert.match(galaxySrc, /Vote for \$\{c\.display_name\}|Vote for /);
  assert.match(galaxySrc, /voteForCandidate/);
  assert.doesNotMatch(galaxySrc, />Change vote</);
  assert.doesNotMatch(galaxySrc, />Vote</);
  assert.match(galaxySrc, /Suggestion submitted for review\./);
  assert.match(galaxySrc, /Pending suggestions/);
  assert.match(galaxySrc, /Pending review/);
  assert.match(galaxySrc, /writePendingNameTheForkVote/);
  assert.match(galaxySrc, /nameTheFork__shell/);
  assert.match(galaxySrc, /nameTheFork__suggestCard/);
  assert.doesNotMatch(galaxySrc, /nameTheFork__panelTitle/);
  assert.doesNotMatch(galaxySrc, /\bAgainst\b|\bNeutral\b/);
  assert.doesNotMatch(galaxySrc, /user_proposal_stances/);

  assert.match(cssSrc, /\.nameTheFork__shell/);
  assert.match(cssSrc, /min\(1120px/);
  assert.doesNotMatch(cssSrc, /\.nameTheFork__body \{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s*min\(/);
});

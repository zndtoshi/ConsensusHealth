import { useEffect, useId, useRef } from "react";
import { parseInfoPagePath } from "../utils/infoPagePath";
import { resolvePublicContactEmail } from "../utils/publicContactEmail";

function PrivacyBody({ contactLine, sessionTtlDays, backupRetentionDays }) {
  const ttl =
    Number.isFinite(Number(sessionTtlDays)) && Number(sessionTtlDays) > 0
      ? Math.floor(Number(sessionTtlDays))
      : 30;
  const sessionDaysLabel = `${ttl} day${ttl === 1 ? "" : "s"}`;
  const backupDays =
    Number.isFinite(Number(backupRetentionDays)) && Number(backupRetentionDays) > 0
      ? Math.floor(Number(backupRetentionDays))
      : 7;
  const backupDaysLabel = `${backupDays} day${backupDays === 1 ? "" : "s"}`;
  return (
    <>
      <p>
        Consensus Health helps you see where public Bitcoin voices stand on specific BIPs. This page
        explains what we store and how it is used — in plain language, not legalese.
      </p>
      <h3>What we store when you sign in with X</h3>
      <p>
        Signing in with X (OAuth) lets us connect your account. We store your X user id, handle,
        display name, avatar URL (and a local copy when available), follower count, X bio /
        description, and join date when the API provides it. We use a signed session cookie so you
        stay logged in for {sessionDaysLabel}.
      </p>
      <h3>Public stances and explanations</h3>
      <p>
        Positions you save on a proposal are shown on the public galaxy for that BIP. Optional
        explanations are links to your own X posts; we may store the URL and a short verified
        snippet so others can read why you stand where you do.
      </p>
      <h3>Curated vs self-reported</h3>
      <p>
        Some early accounts were placed from public statements (curated seed). After that, new
        positions come from people who signed in and chose for themselves. The UI labels this
        difference where it matters.
      </p>
      <h3>Cookies and session</h3>
      <p>
        We use a session cookie to keep you signed in for {sessionDaysLabel}. We do not use
        advertising trackers. Local preferences (for example equal avatar size) may also be stored
        in the browser.
      </p>
      <h3>External services</h3>
      <p>
        Authentication and some profile or post checks go through X. The application is hosted on
        Render, Postgres stores application data, and Cloudflare may deliver the public site and
        static assets depending on deployment.
      </p>
      <h3>Retention and deletion</h3>
      <p>
        Provider backups (for example Render Postgres snapshots) may retain copies for up to{" "}
        {backupDaysLabel} under this deployment's configured backup retention policy.
      </p>
      {contactLine ? (
        <h3>Security / privacy contact</h3>
      ) : null}
      {contactLine ? <p>{contactLine}</p> : null}
    </>
  );
}

function TermsBody() {
  return (
    <>
      <p>
        These community guidelines keep Consensus Health useful and honest. They are not a formal
        legal contract with Bitcoin Core, BIP editors, or any official consensus process.
      </p>
      <h3>Own your stance</h3>
      <p>
        Only record a position for an account you control. Do not impersonate others or claim a
        stance on someone else’s behalf.
      </p>
      <h3>No abuse</h3>
      <p>
        Harassment, spam, malware links, or attempts to disrupt the service are not allowed. We may
        remove content or accounts that break these norms.
      </p>
      <h3>Moderation</h3>
      <p>
        Operators may correct clearly abusive or fraudulent entries, freeze positions on final
        snapshot proposals, and refuse service when needed to protect the community map.
      </p>
      <h3>Informational only</h3>
      <p>
        This site visualizes self-reported and curated public positions. It is not official Bitcoin
        consensus, mining signaling, or a binding vote.
      </p>
    </>
  );
}

function HowItWorksBody() {
  return (
    <>
      <p>
        Each BIP has its own galaxy. Avatars are people with a recorded position; colors show
        against, neutral, or approve.
      </p>
      <h3>Avatar size</h3>
      <p>
        By default, avatar size scales with follower count so larger voices are easier to spot. You
        can switch to equal-size packing from preferences when signed in.
      </p>
      <h3>Stance colors</h3>
      <p>
        Against, neutral, and approve use distinct colors across the map, lists, and stance picker
        so clusters stay readable at a glance.
      </p>
      <h3>Curated and self-reported</h3>
      <p>
        Final snapshot galaxies may include a curated seed. Ongoing proposals emphasize positions
        people chose after signing in with X.
      </p>
      <h3>Proposal-specific voting</h3>
      <p>
        Your stance is stored per BIP. Changing position on one proposal does not rewrite another.
        Final snapshots lock positions but may still allow managing an explanation link.
      </p>
      <h3>Statistics</h3>
      <p>
        The statistics view summarizes counts and history for the active proposal. Numbers can lag
        briefly after updates.
      </p>
      <h3>Distant galaxies</h3>
      <p>
        Use the header dropdown (and distant-galaxy previews when available) to travel between BIP
        galaxies without losing the overall map metaphor.
      </p>
    </>
  );
}

const TITLES = {
  privacy: "Privacy",
  terms: "Terms & guidelines",
  "how-it-works": "How it works",
};

/**
 * Full-viewport glass panel for Privacy / Terms / How it works.
 * Parent owns history.pushState to the info path and back to the proposal route.
 */
export function InfoPages({
  page,
  contactEmail,
  sessionTtlDays = 30,
  backupRetentionDays = 7,
  onClose,
}) {
  const titleId = useId();
  const panelRef = useRef(null);
  const closeBtnRef = useRef(null);
  const resolved =
    parseInfoPagePath(`/${page}`) ||
    (page === "privacy" || page === "terms" || page === "how-it-works" ? page : null);
  const email = resolvePublicContactEmail(contactEmail);
  const contactLine = email ? `Questions about privacy or security: ${email}` : "";

  useEffect(() => {
    if (!resolved) return undefined;
    const prev = document.activeElement;
    closeBtnRef.current?.focus?.();

    function onKeyDown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose?.();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const list = Array.from(focusables).filter((el) => !el.hasAttribute("disabled"));
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (prev && typeof prev.focus === "function") {
        try {
          prev.focus();
        } catch {
          /* ignore */
        }
      }
    };
  }, [resolved, onClose]);

  if (!resolved) return null;

  return (
    <div className="infoPagesOverlay" role="presentation" onClick={() => onClose?.()}>
      <div
        ref={panelRef}
        className="infoPagesPanel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="infoPagesPanel__accent" aria-hidden="true" />
        <header className="infoPagesPanel__header">
          <h1 id={titleId} className="infoPagesPanel__title">
            {TITLES[resolved]}
          </h1>
          <button
            ref={closeBtnRef}
            type="button"
            className="infoPagesPanel__close"
            onClick={() => onClose?.()}
          >
            Close
          </button>
        </header>
        <div className="infoPagesPanel__body">
          {resolved === "privacy" ? (
            <PrivacyBody
              contactLine={contactLine}
              sessionTtlDays={sessionTtlDays}
              backupRetentionDays={backupRetentionDays}
            />
          ) : null}
          {resolved === "terms" ? <TermsBody /> : null}
          {resolved === "how-it-works" ? <HowItWorksBody /> : null}
        </div>
      </div>
    </div>
  );
}

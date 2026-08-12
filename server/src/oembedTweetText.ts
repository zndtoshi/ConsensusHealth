/**
 * Extract plain tweet text from official X/Twitter oEmbed blockquote HTML.
 * Never store or return the raw HTML.
 */

import { parse } from "node-html-parser";

/** Defensive upper bound for stored explanation text (long-form X posts). */
export const MAX_STORED_TWEET_TEXT_CHARS = 10_000;

function decodeAndNormalizeText(raw: string): string {
  return raw
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Pull only the post-content `<p>` from a twitter-tweet blockquote.
 * Attribution ("— Author (@handle) Date"), scripts, and widget markup are ignored.
 */
export function extractTweetTextFromOEmbedHtml(html: unknown): string | null {
  const raw = String(html ?? "");
  if (!raw.trim()) return null;

  let root;
  try {
    root = parse(raw, {
      lowerCaseTagName: true,
      comment: false,
      blockTextElements: {
        script: true,
        style: true,
        noscript: true,
      },
    });
  } catch {
    return null;
  }

  // Remove scripts before reading text.
  for (const el of root.querySelectorAll("script, style, noscript")) {
    el.remove();
  }

  // Only the official post widget — never an arbitrary <blockquote> or timeline.
  const blockquote = root.querySelector("blockquote.twitter-tweet");
  if (!blockquote) return null;
  const paragraph =
    blockquote.querySelector(":scope > p") || blockquote.querySelector("p") || null;
  if (!paragraph) return null;

  // Preserve line breaks from <br> while collecting text-only content.
  for (const br of paragraph.querySelectorAll("br")) {
    br.replaceWith("\n");
  }

  const text = decodeAndNormalizeText(paragraph.textContent || "");
  if (!text) return null;
  if (text.length > MAX_STORED_TWEET_TEXT_CHARS) {
    return text.slice(0, MAX_STORED_TWEET_TEXT_CHARS);
  }
  return text;
}

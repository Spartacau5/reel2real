// URL resolution — the flakiest component, isolated behind one module.
// See SPEC.md → "URL Resolution".
//
// Common interface:  resolve(url) → { caption, images[], author_handle, posted_at? }
//
//   - Instagram: Apify Instagram Scraper (SCRAPER_API_KEY = Apify token).
//                Direct scraping from serverless IPs gets blocked — don't attempt.
//   - TikTok:    open oEmbed first (https://www.tiktok.com/oembed?url=...),
//                scraper API only if oEmbed is insufficient.
//   - Download up to 3 post images (carousels). Video reels: thumbnail + caption only.
//   - Timeout: 8s total. On failure/timeout throw ResolutionError → route returns 422.

export interface ResolvedPost {
  /** Clean, untruncated caption text. Prefer over OCR'd caption when both exist. */
  caption: string;
  /** base64-encoded post images (carousels: up to 3). */
  images: Array<{ data: string; media_type: string }>;
  /** e.g. "@kaafinyc" */
  author_handle: string;
  /** ISO 8601, if available */
  posted_at?: string;
}

/** Thrown when a URL cannot be resolved (block, timeout, unsupported host). */
export class ResolutionError extends Error {
  constructor(message = "resolution_failed") {
    super(message);
    this.name = "ResolutionError";
  }
}

/**
 * Per-attempt resolution timeout. Raised from the SPEC baseline of 8s to 25s
 * because Apify cold runs routinely need >8s. Combined with one automatic retry
 * on timeout (below), worst-case server time is ~50s — which is why /api/resolve
 * sets maxDuration 60. Returns as soon as an attempt succeeds.
 */
export const RESOLUTION_TIMEOUT_MS = 25_000;

/** Total attempts: initial try + one retry on timeout. */
const MAX_ATTEMPTS = 2;

/** Max post images to download (carousels). SPEC.md → URL Resolution. */
const MAX_IMAGES = 3;

/** Default Apify actor; override with APIFY_ACTOR_ID. */
const APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID || "apify~instagram-scraper";

type Platform = "instagram" | "tiktok" | "unknown";

function detectPlatform(url: string): Platform {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (host.includes("instagram.com")) return "instagram";
  if (host.includes("tiktok.com")) return "tiktok";
  return "unknown";
}

function mediaTypeFromUrl(url: string, contentType?: string | null): string {
  if (contentType && contentType.startsWith("image/")) return contentType.split(";")[0];
  if (/\.png(\?|$)/i.test(url)) return "image/png";
  return "image/jpeg"; // Instagram/TikTok CDN images are JPEG.
}

/** Fetch an image URL and base64-encode it, honoring the shared deadline. */
async function fetchImage(
  url: string,
  signal: AbortSignal,
): Promise<{ data: string; media_type: string } | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    return {
      data: buf.toString("base64"),
      media_type: mediaTypeFromUrl(url, res.headers.get("content-type")),
    };
  } catch {
    return null;
  }
}

async function fetchImages(
  urls: string[],
  signal: AbortSignal,
): Promise<Array<{ data: string; media_type: string }>> {
  const unique = [...new Set(urls)].slice(0, MAX_IMAGES);
  const results = await Promise.all(unique.map((u) => fetchImage(u, signal)));
  return results.filter((r): r is { data: string; media_type: string } => r !== null);
}

// ── Instagram (Apify) ──────────────────────────────────────────────────────

function collectInstagramImageUrls(item: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.startsWith("http")) urls.push(v);
  };

  if (Array.isArray(item.images)) item.images.forEach(push);
  push(item.displayUrl);
  if (Array.isArray(item.childPosts)) {
    for (const child of item.childPosts) {
      if (child && typeof child === "object") push((child as Record<string, unknown>).displayUrl);
    }
  }
  return urls;
}

async function resolveInstagram(url: string, signal: AbortSignal): Promise<ResolvedPost> {
  const token = process.env.SCRAPER_API_KEY;
  if (!token) throw new ResolutionError("scraper_key_missing");

  const endpoint = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items?token=${encodeURIComponent(
    token,
  )}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      directUrls: [url],
      resultsType: "posts",
      resultsLimit: 1,
      addParentData: false,
    }),
  });

  if (!res.ok) throw new ResolutionError(`apify_http_${res.status}`);

  const items = (await res.json()) as Array<Record<string, unknown>>;
  const item = Array.isArray(items) ? items[0] : undefined;
  if (!item) throw new ResolutionError("apify_no_data");

  const caption =
    typeof item.caption === "string"
      ? item.caption
      : typeof item.text === "string"
        ? (item.text as string)
        : "";

  const handleRaw =
    (typeof item.ownerUsername === "string" && item.ownerUsername) ||
    (typeof item.ownerFullName === "string" && item.ownerFullName) ||
    "";
  const author_handle = handleRaw ? `@${String(handleRaw).replace(/^@/, "")}` : "";

  const posted_at =
    typeof item.timestamp === "string" ? item.timestamp : undefined;

  const images = await fetchImages(collectInstagramImageUrls(item), signal);

  // A post with neither caption nor images is not usable → fall back to paste.
  if (!caption && images.length === 0) throw new ResolutionError("apify_empty_post");

  return { caption, images, author_handle, posted_at };
}

// ── TikTok (oEmbed) ────────────────────────────────────────────────────────

async function resolveTikTok(url: string, signal: AbortSignal): Promise<ResolvedPost> {
  const oembed = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const res = await fetch(oembed, { signal });
  if (!res.ok) throw new ResolutionError(`tiktok_oembed_http_${res.status}`);

  const data = (await res.json()) as Record<string, unknown>;
  const caption = typeof data.title === "string" ? data.title : "";
  const authorRaw =
    (typeof data.author_unique_id === "string" && data.author_unique_id) ||
    (typeof data.author_name === "string" && data.author_name) ||
    "";
  const author_handle = authorRaw ? `@${String(authorRaw).replace(/^@/, "")}` : "";

  const images =
    typeof data.thumbnail_url === "string"
      ? await fetchImages([data.thumbnail_url], signal)
      : [];

  if (!caption && images.length === 0) throw new ResolutionError("tiktok_empty_post");

  return { caption, images, author_handle };
}

// ── Entry point ────────────────────────────────────────────────────────────

/** AbortSignal.timeout aborts with a TimeoutError; older runtimes use AbortError. */
function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

async function resolveOnce(url: string, signal: AbortSignal): Promise<ResolvedPost> {
  switch (detectPlatform(url)) {
    case "instagram":
      return resolveInstagram(url, signal);
    case "tiktok":
      return resolveTikTok(url, signal);
    default:
      throw new ResolutionError("unsupported_platform");
  }
}

/**
 * Resolve a post URL to caption + images + author. Each attempt gets a fresh 25s
 * budget; on a *timeout* it retries once (explicit failures like empty posts or
 * HTTP errors are not retried). Throws ResolutionError on final failure → the
 * route returns 422 and the frontend shows the screenshot-paste fallback.
 */
export async function resolve(url: string): Promise<ResolvedPost> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const signal = AbortSignal.timeout(RESOLUTION_TIMEOUT_MS);
    try {
      return await resolveOnce(url, signal);
    } catch (e) {
      lastError = e;
      // Explicit, deterministic failures — retrying won't help.
      if (e instanceof ResolutionError) throw e;
      // Retry only on timeout, and only if attempts remain.
      if (isTimeout(e)) continue;
      // Other network error — not retryable.
      throw new ResolutionError("resolution_failed");
    }
  }

  throw new ResolutionError(isTimeout(lastError) ? "resolution_timeout" : "resolution_failed");
}

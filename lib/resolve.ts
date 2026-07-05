// URL resolution — the flakiest component, isolated behind one module.
// See SPEC.md → "URL Resolution".
//
// Common interface:  resolve(url) → { caption, images[], author_handle, posted_at? }
//
//   - Instagram: driver chain, tried in order (env RESOLVE_DRIVER_ORDER):
//       1. sociavault — SociaVault post-info API (SOCIAVAULT_API_KEY). PRIMARY.
//                       8s timeout, no retry — failures fall through to apify.
//       2. apify       — Apify Instagram Scraper (SCRAPER_API_KEY). FALLBACK.
//                       25s per attempt + one retry on timeout.
//     Direct scraping from serverless IPs gets blocked — don't attempt.
//   - TikTok:    oEmbed (https://www.tiktok.com/oembed?url=...).
//   - Download up to 3 post images (carousels). Video reels: thumbnail + caption only.
//   - On total failure throw ResolutionError → route returns 422.

export type ResolveDriver = "sociavault" | "apify" | "tiktok-oembed";

export interface ResolvedPost {
  /** Clean, untruncated caption text. Prefer over OCR'd caption when both exist. */
  caption: string;
  /** base64-encoded post images (carousels: up to 3). */
  images: Array<{ data: string; media_type: string }>;
  /** e.g. "@kaafinyc" */
  author_handle: string;
  /** ISO 8601, if available */
  posted_at?: string;
  /** true if the post is a multi-image carousel (send all images to Claude). */
  is_carousel?: boolean;
  /** which driver produced this result */
  driver?: ResolveDriver;
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

/** SociaVault Instagram post-info endpoint + its (short, no-retry) timeout. */
const SOCIAVAULT_ENDPOINT =
  process.env.SOCIAVAULT_ENDPOINT ||
  "https://api.sociavault.com/v1/scrape/instagram/post-info";
const SOCIAVAULT_TIMEOUT_MS = 8_000;

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

async function apifyInstagram(url: string, signal: AbortSignal): Promise<ResolvedPost> {
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

  const is_carousel =
    item.type === "Sidecar" ||
    (Array.isArray(item.childPosts) && item.childPosts.length > 0) ||
    (Array.isArray(item.images) && item.images.length > 1);
  const images = await fetchImages(collectInstagramImageUrls(item), signal);

  // A post with neither caption nor images is not usable → fall back to paste.
  if (!caption && images.length === 0) throw new ResolutionError("apify_empty_post");

  return { caption, images, author_handle, posted_at, is_carousel };
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

// ── Sociavault (Instagram, PRIMARY) ──────────────────────────────────────────

// The SociaVault response nests media at data.data.xdt_shortcode_media (with a
// data.xdt_shortcode_media fallback for safety). Note: edge_sidecar_to_children
// .edges is an OBJECT MAP ({"0":…,"1":…}), not an array — use Object.values.
type SVMedia = {
  edge_media_to_caption?: { edges?: Record<string, { node?: { text?: string } }> };
  owner?: { username?: string };
  taken_at_timestamp?: number;
  display_url?: string;
  edge_sidecar_to_children?: { edges?: Record<string, { node?: { display_url?: string } }> };
};

function collectSociavaultImageUrls(media: SVMedia): string[] {
  const sidecar = media.edge_sidecar_to_children;
  if (sidecar?.edges) {
    // Includes video children — their display_url is the thumbnail.
    return Object.values(sidecar.edges)
      .map((e) => e?.node?.display_url)
      .filter((u): u is string => typeof u === "string" && u.startsWith("http"));
  }
  return typeof media.display_url === "string" ? [media.display_url] : [];
}

async function resolveSociavault(url: string): Promise<ResolvedPost> {
  const key = process.env.SOCIAVAULT_API_KEY;
  if (!key) throw new ResolutionError("sociavault_key_missing");

  const signal = AbortSignal.timeout(SOCIAVAULT_TIMEOUT_MS); // 8s, no retry
  const endpoint = `${SOCIAVAULT_ENDPOINT}?url=${encodeURIComponent(url)}`;
  const res = await fetch(endpoint, { headers: { "X-API-Key": key }, signal });
  if (!res.ok) throw new ResolutionError(`sociavault_http_${res.status}`);

  const json = (await res.json()) as {
    data?: { data?: { xdt_shortcode_media?: SVMedia }; xdt_shortcode_media?: SVMedia };
  };
  const media = json.data?.data?.xdt_shortcode_media ?? json.data?.xdt_shortcode_media;
  if (!media) throw new ResolutionError("sociavault_no_media");

  // Caption may be absent → empty string. (edges may be an object map; [0] works.)
  const captionEdges = media.edge_media_to_caption?.edges;
  const caption =
    (captionEdges && (Object.values(captionEdges)[0]?.node?.text ?? "")) || "";

  const username = media.owner?.username;
  const author_handle = typeof username === "string" && username ? `@${username}` : "";

  const ts = media.taken_at_timestamp;
  const posted_at = typeof ts === "number" ? new Date(ts * 1000).toISOString() : undefined;

  const is_carousel = !!media.edge_sidecar_to_children?.edges;
  const images = await fetchImages(collectSociavaultImageUrls(media), signal);

  if (!caption && images.length === 0) throw new ResolutionError("sociavault_empty_post");

  return { caption, images, author_handle, posted_at, is_carousel, driver: "sociavault" };
}

// ── Apify (Instagram, FALLBACK) ──────────────────────────────────────────────

/** AbortSignal.timeout aborts with a TimeoutError; older runtimes use AbortError. */
function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

/** Apify driver: 25s per attempt + one retry on timeout. */
async function resolveApify(url: string): Promise<ResolvedPost> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const signal = AbortSignal.timeout(RESOLUTION_TIMEOUT_MS);
    try {
      const post = await apifyInstagram(url, signal);
      return { ...post, driver: "apify" };
    } catch (e) {
      lastError = e;
      if (e instanceof ResolutionError) throw e; // deterministic → don't retry
      if (isTimeout(e)) continue; // retry only on timeout
      throw new ResolutionError("resolution_failed");
    }
  }
  throw new ResolutionError(
    isTimeout(lastError) ? "resolution_timeout" : "resolution_failed",
  );
}

// ── Driver chain + entry point ───────────────────────────────────────────────

/** Instagram driver order, env-configurable (RESOLVE_DRIVER_ORDER). */
function driverOrder(): Array<"sociavault" | "apify"> {
  const raw = (process.env.RESOLVE_DRIVER_ORDER || "sociavault,apify").toLowerCase();
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((d): d is "sociavault" | "apify" => d === "sociavault" || d === "apify");
  return parsed.length ? parsed : ["sociavault", "apify"];
}

/** Try each Instagram driver in order; first success wins, failures fall through. */
async function resolveInstagram(url: string): Promise<ResolvedPost> {
  let lastError: unknown;
  for (const driver of driverOrder()) {
    try {
      return driver === "sociavault"
        ? await resolveSociavault(url)
        : await resolveApify(url);
    } catch (e) {
      lastError = e; // fall through to the next driver
    }
  }
  throw lastError instanceof ResolutionError
    ? lastError
    : new ResolutionError("resolution_failed");
}

async function resolveTikTokDriver(url: string): Promise<ResolvedPost> {
  const signal = AbortSignal.timeout(SOCIAVAULT_TIMEOUT_MS); // 8s
  try {
    const post = await resolveTikTok(url, signal);
    return { ...post, driver: "tiktok-oembed" };
  } catch (e) {
    if (e instanceof ResolutionError) throw e;
    throw new ResolutionError("resolution_failed");
  }
}

/**
 * Resolve a post URL to caption + images + author. Instagram runs the driver
 * chain (SociaVault primary → Apify fallback). Throws ResolutionError on total
 * failure → the route returns 422 and the frontend shows the paste fallback.
 */
export async function resolve(url: string): Promise<ResolvedPost> {
  switch (detectPlatform(url)) {
    case "instagram":
      return resolveInstagram(url);
    case "tiktok":
      return resolveTikTokDriver(url);
    default:
      throw new ResolutionError("unsupported_platform");
  }
}

// Shared types for the /api/extract contract and the extraction pipeline.
// See SPEC.md → "API Contract" and "Item schema".

export type ItemType = "event" | "place" | "recipe" | "product" | "other";

export type Confidence = "high" | "medium" | "low";

// - "past_event":       event is in the past relative to `now`.
// - "insufficient_info": post is readable but a critical field is missing
//                        (e.g. a truncated caption cut off the date).
// - "unreadable":        extraction failed entirely — synthesized fallback, the
//                        model produced no usable output. Distinct from
//                        "insufficient_info" so the two never blur together.
export type SkippedReason =
  | null
  | "past_event"
  | "insufficient_info"
  | "unreadable";

export interface Reminder {
  /** ISO 8601 — when to be reminded */
  date: string;
  /** what the notification should say */
  label: string;
}

/** One actionable item extracted from a post. See SPEC.md → Item schema. */
export interface Item {
  type: ItemType;
  /** short, calendar-friendly, no emoji */
  title: string;
  /** key details: price/free, RSVP requirement, performers, address, handle */
  notes: string;

  // EVENT fields (null for other types)
  start: string | null; // ISO 8601 with timezone offset, or null
  end: string | null;
  all_day: boolean;
  is_date_range: boolean;
  range_end_date: string | null; // YYYY-MM-DD or null
  location: string | null;
  action: string; // concrete verb: 'RSVP', 'buy tickets', 'just show up', ...

  // PLACE fields
  place_name: string | null;
  address: string | null;

  // LOCATION ENRICHMENT (deterministic post-processing — never set by the model)
  // See SPEC.md → Location Enrichment. `address` (stated in the post) is never
  // overridden; `resolved_address` is only populated when the post stated none.
  resolved_address: string | null; // verified address from Google Places
  address_source: "stated" | "resolved" | null;
  maps_url: string | null; // Google Maps link for a resolved address

  // REMINDER suggestion (all types)
  reminder: Reminder | null;

  skipped_reason: SkippedReason;
}

/** Successful 200 response body from POST /api/extract. */
export interface ExtractResponse {
  items: Item[];
  /** one-line plain-English description of the post */
  post_summary: string;
  confidence: Confidence;
}

/** Error response body — the frontend renders this in its error state. */
export interface ErrorResponse {
  error: string;
  /** optional human-readable detail */
  message?: string;
}

/** A single base64 image with its media type. */
export interface EncodedImageInput {
  data: string;
  media_type: string;
}

/** Request body for POST /api/resolve. */
export interface ResolveRequest {
  url: string;
}

/**
 * Validated, normalized request after passing the /api/extract contract checks.
 * Exactly one source is present:
 *   - a single pasted screenshot (`image` + `media_type`), OR
 *   - a pre-resolved bundle from /api/resolve (`images` and/or `caption`).
 * URL resolution now lives in its own route (POST /api/resolve).
 */
export interface ExtractRequest {
  // Screenshot path
  image?: string; // base64-encoded PNG/JPEG
  media_type?: string; // required when `image` is present

  // Pre-resolved path (from /api/resolve)
  caption?: string;
  images?: EncodedImageInput[];
  author_handle?: string;
  posted_at?: string;

  now: string; // ISO 8601 with offset (required)
  timezone: string; // IANA tz, e.g. "America/New_York" (required)
}

/** Normalized input handed to the Claude extraction call. */
export interface ExtractionInput {
  /** Clean caption text (from URL resolution) when available. */
  caption?: string;
  /** base64 images (screenshot from client, or resolved post images). */
  images: Array<{ data: string; media_type: string }>;
  author_handle?: string;
  posted_at?: string;
  now: string;
  timezone: string;
}

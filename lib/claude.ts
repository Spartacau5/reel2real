// Claude vision extraction — server-side only.
// See SPEC.md → "System Prompt Requirements", "Item schema", and the
// Date/Time, Reminder, Image Handling, and Classification rule sections.
//
//   - Model: claude-sonnet-4-6 via the Anthropic Messages API (vision + text).
//   - Return ONLY valid JSON matching the schema. No prose, no markdown fences.
//   - Include `now` and `timezone` in the prompt at request time.
//   - Temperature 0. Validate with zod; retry once on parse failure. If it still
//     doesn't parse, DON'T error — synthesize a type:"other" item at low
//     confidence (SPEC.md → Error Handling: "Nothing actionable → never error").

import Anthropic from "@anthropic-ai/sdk";
import type { ExtractionInput, ExtractResponse } from "./types";
import { extractResponseSchema } from "./schema";
import { downscaleImage } from "./image";
import { markPastEvents } from "./postprocess";
import { enrichLocations } from "./geocode";

/** Per-stage timings for one /api/extract call (all ms). */
export interface ExtractTimings {
  downscale_ms: number; // wall-clock for the (parallel) image downscale
  per_image_ms: number[]; // each image's own downscale duration
  images_sent: number;
  anthropic_ms: number; // pure Anthropic Messages API call(s)
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  max_tokens: number;
  geocode_ms: number; // Google Places enrichment
  other_ms: number; // parse/validate/postprocess/json — the remainder
  total_ms: number;
}

/** extract() returns the response plus per-stage timings for observability. */
export interface ExtractResult {
  data: ExtractResponse;
  timings: ExtractTimings;
}

/** Model id per SPEC.md → Architecture. Override with EXTRACT_MODEL. */
export const MODEL = process.env.EXTRACT_MODEL || "claude-sonnet-4-6";

const MAX_TOKENS = 4096;

/**
 * Reserved for genuinely unrecoverable extraction errors (→ 502). Parse failures
 * no longer throw this — they fall back to a synthesized "other" item so the
 * frontend always gets a 200 it can render (SPEC.md → Error Handling).
 */
export class ClaudeParseError extends Error {
  constructor(message = "extraction_failed") {
    super(message);
    this.name = "ClaudeParseError";
  }
}

/**
 * Never-error fallback. When Claude's output can't be parsed into the schema
 * after the retry, return one type:"other" item at low confidence rather than
 * failing the request.
 */
function synthesizeOther(): ExtractResponse {
  return {
    items: [
      {
        type: "other",
        title: "Couldn’t read this post",
        notes: "",
        start: null,
        end: null,
        all_day: false,
        is_date_range: false,
        range_end_date: null,
        location: null,
        action: "",
        place_name: null,
        address: null,
        resolved_address: null,
        address_source: null,
        maps_url: null,
        reminder: null,
        skipped_reason: "unreadable",
      },
    ],
    post_summary:
      "Couldn’t automatically structure this post. Try a clearer screenshot or check the original.",
    confidence: "low",
  };
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    client = new Anthropic({ apiKey });
  }
  return client;
}

/**
 * Full system prompt: schema + every extraction rule from SPEC.md. STATIC (no
 * per-request data) so it can be prompt-cached — `now`/`timezone` are sent in
 * the user turn instead (see buildUserContent), keeping the cached prefix stable.
 */
export function buildSystemPrompt(): string {
  return `You extract actionable intent from social media posts (usually Instagram/TikTok) and return ONLY valid JSON. No prose, no markdown fences, no code blocks — the first character of your reply MUST be "{".

Resolve every relative date/time against the CURRENT TIME (now) and TIMEZONE provided in the user message.

Return an object of this exact shape:
{
  "items": [ Item, ... ],            // ARRAY. A post can contain multiple items — never collapse distinct events into one.
  "post_summary": "one-line plain-English description of the post",
  "confidence": "high" | "medium" | "low"
}

Each Item:
{
  "type": "event" | "place" | "recipe" | "product" | "other",
  "title": "short, calendar-friendly, no emoji",
  "notes": "key details: price/free, RSVP requirement, performers, address, original @handle",
  "start": "ISO 8601 with timezone offset, or null",
  "end": "ISO 8601 or null",
  "all_day": true | false,
  "is_date_range": true | false,     // multi-day thing (pop-up/festival), not a single occurrence
  "range_end_date": "YYYY-MM-DD or null",
  "location": "venue name + address if available, or null",
  "action": "concrete verb: 'RSVP', 'buy tickets', 'just show up', 'visit before it closes'",
  "place_name": "string or null",
  "address": "string or null",
  "reminder": { "date": "ISO 8601", "label": "what the notification says" } | null,
  "skipped_reason": null | "insufficient_info"   // do NOT set past_event — past events are detected automatically after extraction
}

CLASSIFICATION:
- event: date/time + a happening (screening, show, pop-up, festival, watch party) → calendar event + reminder.
- place: restaurant/cafe/shop/venue with an address but NO date → start/end null, all_day false; suggest a reminder.
- recipe: cooking instructions/dish walkthrough → reminder ("Make X"), ingredients in notes if visible.
- product: item for sale/drop/merch → reminder with link/handle in notes.
- other: meme / nothing actionable → no reminder, one-line summary only. Never error.
- A post can yield MIXED types. A pop-up shop is an event (the date range matters more than shopping).
- When uncertain between event and place, prefer place if no date exists.

DATE & TIME:
1. Resolve relative to now + timezone. If a stated weekday and date conflict, TRUST THE EXPLICIT DATE and note the discrepancy in notes.
2. No year stated → assume the next occurrence.
3. Explicit year stated → use it.
4. Date ranges (pop-ups/festivals): start = opening day, all_day true, is_date_range true, range_end_date = final day. Daily hours (e.g. "11AM–8PM") go in notes, not as event times.
5. Multiple showtimes same day, same event series → ONE item, start = first showtime, both times in notes.
6. Multiple distinct events across dates → separate items, one per date.
7. No time given → all_day true; reminder for 9:00 AM local on the reminder date.
8. Opening hours ≠ event time. "Daily 11AM–8PM" is hours → all_day visit, hours in notes.
9. NEVER split same-event showtimes. Multiple showtimes of the same event/series on the same day = ONE item (start = first showtime, all times in notes). Two films at one movie night is ONE outing, not two items.
10. NEVER use post metadata as an event time. The post's publish time (posted_at), a "posted 1w ago" label, or a status-bar clock is NOT an event time. Only times stated in the caption/flyer count. No stated time → all_day true; do not borrow a time from metadata.
11. Emit one item per distinct dated sub-event, even when a caption frames them inside one opening/pop-up window — a series listing June 27, July 2, July 4, July 9 is FOUR items, not one. Do NOT decide which are past; that is handled automatically after extraction.
12. Multiple dates like "X & Y" that appear together WITH range language ("through the Nth", "until the Nth", "open X–Y", "available X through Y") → ONE date-range item ending on the Nth: all_day true, is_date_range true, range_end_date = the Nth, start = the first date; put the featured dates in notes. WITHOUT explicit range language, distinct dates stay distinct items (rule 11). Example: "collab July 4 & 11, available through the 11th" → one all-day range July 4→11.

REMINDER TIMING:
- Ticketed/RSVP events → reminder 3 days before start; label includes the action.
- Free/just-show-up events → reminder 10:00 AM the day before.
- Same-week events (< 3 days away) → reminder tomorrow 10:00 AM, or in 2 hours if the event is tomorrow.
- Date-range things → reminder 2 days after opening.
- Places (no date) → reminder Saturday 11:00 AM of the upcoming weekend.
- Recipes → reminder next Sunday 4:00 PM.
- Never set a reminder in the past. If the computed reminder < now, use now + 2 hours.

IMAGES:
- STRONGEST RULE — ADDRESSES ARE VERBATIM OR NULL. Copy any address, cross-street, ZIP, or venue detail EXACTLY as written in the caption or image. NEVER supply an address, cross-street, ZIP, or venue detail from your own knowledge of the place. If a venue is named but no address is literally present in the post, address = null and location holds only what the post states (e.g. the venue name). Inventing a plausible-but-unstated address is the worst failure — when in doubt, null.
- Ignore UI chrome (status bar, IG buttons, comment box, nav bar). Never read a status-bar clock or the post's publish time as an event time.
- Info may live in the flyer image, the caption, or both — MERGE them. Flyer usually has date/time; caption has context and handles.
- Captions may be truncated ("...more"). Extract what's visible; if a critical field (date) is cut off, lower confidence and say what's missing in post_summary.
- Reels: the video frame may be useless; the caption/overlay carries the content. Never guess from the frame alone.
- Account handles (@name) are high-value — include in notes.

RULES:
- Never invent dates, times, addresses, cross-streets, ZIPs, or prices not literally present in the input. Addresses especially: verbatim from the post or null (see IMAGES, strongest rule).
- items is always an array. Nothing actionable → one item of type "other".
- Output JSON only.`;
}

type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: "image/png" | "image/jpeg"; data: string };
};

async function buildUserContent(input: ExtractionInput): Promise<{
  content: Array<ImageBlock | { type: "text"; text: string }>;
  downscaleMs: number;
  perImageMs: number[];
}> {
  const content: Array<ImageBlock | { type: "text"; text: string }> = [];

  // Send all images only for carousels; otherwise just the first (a single post
  // / reel / screenshot needs one image). Saves vision tokens.
  const selected = input.is_carousel ? input.images : input.images.slice(0, 1);

  // Downscale to <=1568px before sending to Claude (SPEC.md → Image Handling).
  // Images run in PARALLEL (Promise.all); per-image timing proves it (wall ≈ max).
  const perImageMs: number[] = [];
  const dt0 = Date.now();
  const downscaled = await Promise.all(
    selected.map(async (img) => {
      const t = Date.now();
      const r = await downscaleImage(img.data, img.media_type);
      perImageMs.push(Date.now() - t);
      return r;
    }),
  );
  const downscaleMs = Date.now() - dt0;

  for (const img of downscaled) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.media_type, data: img.data },
    });
  }

  // Per-request now/timezone go in the USER turn (not the cached system prompt)
  // so the system prefix stays byte-stable and cacheable.
  content.push({
    type: "text",
    text: `CURRENT TIME (now): ${input.now}\nTIMEZONE: ${input.timezone}`,
  });

  // Caption (from URL resolution) is clean and untruncated — prefer it over OCR.
  if (input.caption) {
    const meta = [
      input.author_handle ? `Author: ${input.author_handle}` : "",
      input.posted_at ? `Posted at: ${input.posted_at}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    content.push({
      type: "text",
      text: `Post caption (clean text — prefer over any OCR'd caption in the image):\n${meta}\n\n${input.caption}`,
    });
  }

  content.push({
    type: "text",
    text: "Extract all actionable items from this post as JSON per the schema. Output JSON only.",
  });

  return { content, downscaleMs, perImageMs };
}

function parseJson(text: string): unknown {
  // Strip accidental markdown fences before parsing.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

function textFromResponse(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Run the extraction: one Claude call, validate with zod. If the output is not
 * valid JSON matching the schema, retry once with "return only valid JSON"
 * appended. If it still doesn't parse, synthesize a type:"other" item at low
 * confidence rather than erroring (SPEC.md → Error Handling: never error).
 */
export async function extract(input: ExtractionInput): Promise<ExtractResult> {
  const anthropic = getClient();
  const t0 = Date.now();

  const { content: userContent, downscaleMs, perImageMs } = await buildUserContent(input);

  // System prompt is static → cache it (prompt caching). now/timezone live in
  // the user turn so this prefix never changes across requests.
  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: buildSystemPrompt(),
      cache_control: { type: "ephemeral" },
    },
  ];

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userContent },
  ];

  let anthropicMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;

  const finish = (
    data: ExtractResponse,
    geocodeMs: number,
  ): ExtractResult => {
    const total = Date.now() - t0;
    return {
      data,
      timings: {
        downscale_ms: downscaleMs,
        per_image_ms: perImageMs,
        images_sent: perImageMs.length,
        anthropic_ms: anthropicMs,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheRead,
        max_tokens: MAX_TOKENS,
        geocode_ms: geocodeMs,
        other_ms: Math.max(0, total - downscaleMs - anthropicMs - geocodeMs),
        total_ms: total,
      },
    };
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const tA = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system,
      messages,
    });
    anthropicMs += Date.now() - tA;

    const u = response.usage;
    inputTokens += u.input_tokens;
    outputTokens += u.output_tokens;
    cacheRead += u.cache_read_input_tokens ?? 0;

    const raw = textFromResponse(response);
    try {
      const parsed = extractResponseSchema.parse(parseJson(raw));
      // Deterministic post-processing (SPEC.md → Post-Processing / Location
      // Enrichment): mark past events in code, then resolve missing addresses.
      parsed.items = markPastEvents(parsed.items, input.now);
      const tG = Date.now();
      parsed.items = await enrichLocations(parsed.items);
      return finish(parsed, Date.now() - tG);
    } catch {
      if (attempt === 0) {
        // One retry: feed back the bad output and demand valid JSON only.
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content:
            "That was not valid JSON matching the schema. Return ONLY the JSON object, no prose, no markdown fences.",
        });
        continue;
      }
      // Retry exhausted — never error; return a synthesized "other" item.
      console.warn("[claude] extraction unparseable after retry; synthesizing 'other'");
      return finish(synthesizeOther(), 0);
    }
  }

  // Unreachable, but keeps the type checker happy.
  return finish(synthesizeOther(), 0);
}

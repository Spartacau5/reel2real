# SPEC — "Send to Agent" v1
Instagram post → screenshot → structured action (calendar event / reminder) with zero manual typing.

## Overview

A single-page web app: paste a screenshot of a social media post (usually Instagram), Claude vision extracts actionable intent server-side, and each item renders as an editable card the user can push to their calendar via .ics download or a prefilled Google Calendar link. No accounts, no database, no OAuth.

## User Flow (v1: link-first, screenshot fallback)

**Primary — share button:**
1. User taps Share on an IG/TikTok post → shares to the app:
   - **Android:** installed PWA registers as a Web Share Target (manifest `share_target`) → receives the URL directly
   - **iOS:** a 3-action Apple Shortcut ("Send to Agent") in the share sheet accepts the URL and opens `https://<app>/?url=<encoded>` (iOS web apps cannot register as share targets — this is the only web-only workaround)
2. App auto-submits the URL to `/api/extract`
3. Backend resolves the URL (see URL Resolution) → caption text + post image(s) → Claude extraction
4. Items render as editable cards (same as below)

**Fallback — paste a screenshot:**
1. If URL resolution fails, or the user prefers: paste/upload a screenshot on the same page
2. Same extraction, image-only path

**Review & commit (both paths):**
5. Each item renders as an EDITABLE card: title, start/end, location, notes, reminder date — all user-adjustable before committing
6. Per card, "Add to Calendar": **.ics download** (opens natively in Apple/Google Calendar) or **Google Calendar link** (prefilled via URL template, no OAuth)
7. Dateless items (places, recipes, products) show a date picker pre-filled with suggested `reminder.date` — accept, edit, or skip
8. Items with `skipped_reason: "past_event"` render greyed out, no actions

## Architecture

- **App:** Next.js on Vercel — one page (share/paste → review → add) + one API route (`/api/extract`)
- **Model:** `claude-sonnet-4-6` via Anthropic Messages API (vision + text), called server-side only
- **URL resolution:** scraper API for Instagram, oEmbed for TikTok (see URL Resolution) — isolated in `lib/resolve.ts`
- **Calendar integration:** client-side .ics generation + Google Calendar URL templates. NO calendar OAuth, no calendar API
- **Share intake:** PWA `share_target` in manifest (Android); `?url=` query param auto-submit (iOS Shortcut forwarder + universal deep-link entry)
- **State:** none. No DB in v1. Nothing persisted server-side
- **Auth:** none for v1 (personal use); basic rate limiting on the API route
- **Env vars:** `ANTHROPIC_API_KEY`, `SCRAPER_API_KEY` (Vercel env vars only — never in the repo, never client-side)
- **Mobile:** mobile-first layout, PWA manifest, installable to home screen

### Frontend requirements

- Entry via `?url=` query param: auto-submit on load, show which post is being processed
- Paste zone (fallback + desktop): `paste` events (clipboard images) AND file upload AND drag-drop AND a URL text field
- States: empty, resolving (URL fetch), extracting (~5–10s — progress affordance), results, error-with-fallback ("couldn't read that link — paste a screenshot")
- Item cards: every schema field user-editable inline before committing; edits affect the generated .ics/gcal link
- Multi-item posts render as a stack of cards, individually actionable
- Screenshots downscaled client-side (canvas, max 1568px) before upload

## API Contract

### POST `/api/extract`

**Request body (exactly one of `url` or `image` required):**
```json
{
  "url": "https://www.instagram.com/p/... or TikTok URL (optional)",
  "image": "<base64-encoded PNG/JPEG> (optional)",
  "media_type": "image/png (required with image)",
  "now": "2026-07-03T20:15:00-04:00",
  "timezone": "America/New_York"
}
```

`now` and `timezone` are REQUIRED (frontend sends them automatically). All relative-date resolution depends on them. Reject requests missing them with 400. Reject requests with both or neither of `url`/`image` with 400.

## URL Resolution

The flakiest component — isolate it behind one module (`lib/resolve.ts`) with a common interface: `resolve(url) → { caption, images[], author_handle, posted_at? }`.

- **Instagram:** third-party scraper API (Apify Instagram Post Scraper or equivalent). Env var: `SCRAPER_API_KEY`. Instagram's own oEmbed requires Meta app review — not v1. Direct scraping from serverless IPs gets blocked — don't attempt.
- **TikTok:** open oEmbed first (`https://www.tiktok.com/oembed?url=...` → title/thumbnail/author); scraper API only if oEmbed is insufficient.
- Download up to 3 post images (carousels), downscale to 1568px, pass to Claude ALONGSIDE the caption text as a separate text block. Caption via URL is clean and untruncated — prefer it over OCR'd caption when both exist.
- Resolution timeout: 8s. On failure/timeout return 422 `{error: "resolution_failed"}` → frontend shows the screenshot-paste fallback with a friendly message.
- Video reels: never fetch video. Thumbnail + caption only (caption carries the content — see test case 4).

**Response body (200):**
```json
{
  "items": [ Item, ... ],
  "post_summary": "one-line plain-English description of the post",
  "confidence": "high" | "medium" | "low"
}
```

`items` is an ARRAY. A single post can contain multiple actionable items (see Example 6 — one Nando's post contains 4 separate events). Never collapse distinct events into one.

### Item schema

```json
{
  "type": "event" | "place" | "recipe" | "product" | "other",
  "title": "string — short, calendar-friendly, no emoji",
  "notes": "string — key details: price/free, RSVP requirement, performers, address, original account handle",

  // EVENT fields (null for other types)
  "start": "ISO 8601 with timezone offset, or null",
  "end": "ISO 8601 or null",
  "all_day": true | false,
  "is_date_range": true | false,      // multi-day thing like a pop-up, not a single occurrence
  "range_end_date": "YYYY-MM-DD or null",
  "location": "string or null — venue name + address if available",
  "action": "string — the concrete verb: 'RSVP', 'buy tickets', 'just show up', 'visit before it closes'",

  // PLACE fields
  "place_name": "string or null",
  "address": "string or null",       // VERBATIM from the post, or null (never from model knowledge)

  // LOCATION ENRICHMENT (added deterministically in post-processing — not by the model)
  "resolved_address": "string or null",   // verified address from Google Places, only when `address` was null
  "address_source": null | "stated" | "resolved",
  "maps_url": "string or null",           // Google Maps link for a resolved address

  // REMINDER suggestion (all types)
  "reminder": {
    "date": "ISO 8601 — when to be reminded",
    "label": "string — what the notification should say"
  } | null,

  "skipped_reason": null | "past_event" | "insufficient_info"
}
```

## Classification Rules

| Type | Signals | Output behavior |
|---|---|---|
| `event` | Date/time + happening (screening, show, pop-up, festival, watch party) | Calendar event + reminder |
| `place` | Restaurant/café/shop/venue with an address but NO date | Card shows a date picker pre-filled with suggested date; picking one enables an all-day calendar add. If skipped, item stays reminder-suggestion only |
| `recipe` | Cooking instructions or dish walkthrough | Reminder ("Make X") + ingredients in notes if visible |
| `product` | Item for sale, drop, merch | Reminder with link/handle in notes |
| `other` | Meme, nothing actionable | No reminder. One-line summary only. Never error. |

A post can yield items of MIXED types (e.g., a pop-up shop is an `event` — the date range matters more than the shopping).

## Date & Time Resolution Rules

These are the highest-value rules. Get these wrong and the whole product fails.

1. **Always resolve relative to `now` + `timezone` from the request.** "Next Tuesday, July 7th" → resolve to the concrete date; if the stated weekday and date conflict, TRUST THE EXPLICIT DATE and note the discrepancy in `notes`.
2. **No year stated → assume the next occurrence.** A July 8 post seen on July 3, 2026 means July 8, 2026.
3. **Explicit year stated → use it** (Example 5 says "Saturday July 18 2026").
4. **Date ranges (pop-ups, festivals):** set `start` = opening day, `all_day: true`, `is_date_range: true`, `range_end_date` = final day. The client generates ONE all-day calendar event spanning the ENTIRE range (start → range_end_date inclusive). Daily hours (e.g., "11AM–8PM") go in `notes`, not as event times. Note for .ics generation: DTEND for all-day events is EXCLUSIVE per RFC 5545 — set DTEND to range_end_date + 1 day so the block visually covers the final day.
5. **Multiple showtimes, same day, same event series** (Example 2: 4 PM + 7 PM films): ONE item, `start` = first showtime, both times in `notes`. Two different films at one movie night = one outing.
6. **Multiple distinct events across dates** (Example 6): separate items, one per date.
7. **Past events relative to `now`:** the item gets `skipped_reason: "past_event"` and `reminder: null`. (Example 6: June 27 and July 2 are past on July 3.) **This is applied deterministically in post-processing (in code), not by the model — see Post-Processing.** The model does not set `past_event`.
8. **No time given:** `all_day: true`, and reminder set for 9:00 AM local on the reminder date.
9. **Opening hours ≠ event time.** "Daily 11AM–8PM" is hours, not a start time → all_day visit, hours go in `notes`.
10. **Never split same-event showtimes.** Multiple showtimes of the same event or series on the same day are ONE item — `start` = first showtime, every time listed in `notes`. Two different films at one movie night is one outing, not two items. (Reinforces rule 5: do NOT emit one item per screening.)
11. **Never use post metadata as an event time.** The post's own publish time (`posted_at`), a "posted 1w ago" label, or a status-bar clock is NOT an event time. Only dates/times stated in the caption or flyer are the actual happening. If a "happening" has no stated time, it is `all_day: true` — do not borrow a time from metadata.
12. **Judge each sub-event's past/future independently.** When a caption frames several dated sub-events inside one window or pop-up range (e.g. "June 27–July 11"), evaluate EACH dated sub-event against `now` on its own. Any whose date is before `now` get `skipped_reason: "past_event"` and `reminder: null` — even though the overall window is still open.

## Reminder Timing Rules

- Ticketed / RSVP events → reminder 3 days before `start`, label includes the action: "RSVP for Rastah pop-up (opens July 8)"
- Free / just-show-up events → reminder at 10:00 AM the day before
- Same-week events (< 3 days away) → reminder tomorrow at 10:00 AM, or in 2 hours if event is tomorrow
- Date-range things (pop-ups) → reminder 2 days after opening: "Rastah pop-up is open — closes July 19"
- Places (no date) → reminder Saturday 11:00 AM of the upcoming weekend: "Try Kaafi — Pakistani café, 109 Ludlow St"
- Recipes → reminder next Sunday 4:00 PM (default cook-something slot)
- Never set a reminder in the past. If computed reminder < `now`, use `now` + 2 hours.

## Image Handling Rules

- **Addresses and venue details are VERBATIM or null — STRONGEST RULE.** Copy any address, cross-street, ZIP, or venue detail EXACTLY as it appears in the caption or image. NEVER supply an address, cross-street, ZIP, or venue detail from your own knowledge of the place. If a venue is named but no address is literally present in the post, `address` is `null` and `location` contains only what the post states (e.g. the venue name). Inventing a plausible-but-unstated address is the worst failure mode — when in doubt, leave it null.
- Screenshots contain UI chrome (status bar, IG buttons, comment box, nav bar). IGNORE all of it. Never extract "8:11" from the status bar as an event time, and never read the post's publish time as an event time (see Date & Time rule 11).
- Information may live in the flyer image, the caption, or both. MERGE them; flyer usually has date/time, caption usually has context and handles.
- Captions may be truncated ("...more"). Extract what's visible; if a critical field (date) is cut off, lower `confidence` and say what's missing in `post_summary`.
- Carousel posts ("1/4", "2/3") show one slide. Extract what's visible; note in `notes` if it references other slides.
- Reels: the video frame may be useless (Example 4 is a close-up of a spatula) — the caption/overlay text carries the content. Never guess from the frame alone.
- Account handles (@kaafinyc, @houseofgoalny) are high-value — include in `notes` for later lookup.

## System Prompt Requirements (for the Claude call)

- Return ONLY valid JSON matching the schema. No prose, no markdown fences.
- Include `now` and `timezone` in the prompt at request time.
- Instruct: when uncertain between event/place, prefer `place` if no date exists.
- Instruct: never invent dates, times, addresses, or prices not present in the image.
- Temperature 0. Use tool-use / structured output if available for schema enforcement, else validate with zod and retry once on parse failure.

## Error Handling

- Claude returns unparseable JSON → one retry with "return only valid JSON" appended → then 502 with `{error}`
- Image too large → downscale server-side to max 1568px long edge before sending to Claude
- Nothing actionable → 200 with `items: [{type:"other", ...}]`, never 4xx/5xx
- All errors return JSON the frontend renders in the error state

## Post-Processing (deterministic)

After Claude returns items, two deterministic steps run in code (not in the model) before the response is sent. Doing these in code — rather than asking the model to — makes them reliable and testable.

1. **Past-event detection** (`lib/postprocess.ts`). For every item, compare its date to `now`:
   - Date-range item: past when `range_end_date` is before today (the whole range has ended).
   - All-day item: past when its date is before today.
   - Timed item: past when `start` is before `now` (includes earlier today).

   Any past item is set to `skipped_reason: "past_event"` and `reminder: null`. This is authoritative — it also clears a `past_event` the model set by mistake. The model is instructed NOT to set `past_event` itself (rule 7 is enforced here, not in the prompt).

2. **Location enrichment** (see below).

## Location Enrichment

Addresses are copied verbatim from the post or left null (Image Handling, strongest rule) — so a named venue often has `address: null`. Enrichment (`lib/geocode.ts`) fills the gap **without ever overriding what the post stated**:

- **Provider:** Google **Places API (New)** Text Search (`POST places.googleapis.com/v1/places:searchText`, `X-Goog-Api-Key` + field mask). Env var: `GOOGLE_MAPS_API_KEY` (server-side only; if unset, enrichment is a no-op). Requires "Places API (New)" enabled + billing on the Cloud project.
- **When it runs:** only for items with a venue name (`place_name` or `location`) but `address: null`.
- **What it sets:** `resolved_address` (the verified formatted address), `maps_url` (a Google Maps link), and `address_source: "resolved"`.
- **Never overrides a stated address:** if the post stated an address, the item keeps it and is tagged `address_source: "stated"` — no lookup is made.
- **Field semantics:** `address` = what the post literally said (or null). `resolved_address` = what geocoding found (only when `address` was null). `address_source` tells the client which to trust: `"stated"` | `"resolved"` | null (unresolved).
- Timeout 5s per lookup; failures leave the item unenriched (`address_source: null`).

## Test Cases (real screenshots, in /test-images)

### 1. `IMG_4934.png` — Rastah × NYC pop-up (ad)
Flyer + caption both present. Expect ONE item:
- type: event, title: "Rastah NYC Pop-Up"
- is_date_range: true, all_day: true, start: 2026-07-08, range_end_date: 2026-07-19
- One all-day block spanning July 8–19 (.ics DTEND = July 20 per exclusivity rule)
- location: "21 Spring St, New York, NY 10011", hours "Daily 11AM–8PM" in notes
- action: "RSVP" (caption says RSVP for early access)
- reminder: ~July 5, label mentions RSVP

### 2. `IMG_4935.png` — Domino Park Movie Night
Caption-heavy. Expect ONE item:
- type: event, title: "Movie Night at Domino Park"
- start: 2026-07-07T16:00-04:00, both films in notes ("The Sandlot 4 PM, Bend It Like Beckham 7 PM")
- location: "Domino Park, Brooklyn"
- action: "just show up"
- reminder: July 6, 10 AM

### 3. `IMG_4936.png` — World Cup festival, House of Goal
Info split image/caption. Expect ONE item:
- type: event, title: "World Cup Festival — House of Goal"
- is_date_range: true, all_day: true, 2026-07-03 → 2026-07-19 (one all-day block for the full range), location: "Industry City, Brooklyn"
- notes: FREE to attend, @houseofgoalny
- Range already started at `now` → reminder near-term, e.g., tomorrow 10 AM

### 4. `IMG_4937.png` — Kaafi (Pakistani café reel)
Video frame useless; caption has everything. Expect ONE item:
- type: place, place_name: "Kaafi", address: "109 Ludlow St, New York, NY 10002"
- notes: menu highlights (chai, naanwich, samosa chaat...), @kaafinyc
- No date in post → card shows date picker pre-filled with suggested date (upcoming Saturday 11 AM), user can accept/edit/skip
- If user picks a date: reminder + all-day calendar event that day. If skipped: reminder-only at suggested date
- start/end/all_day: null/null/false in the API response (the date decision happens on-device)

### 5. `IMG_4938.png` — Basement Bhangra Beyond (Babbulicious)
Cleanest case. Expect ONE item:
- type: event, title: "Basement Bhangra Beyond: Babbulicious"
- start: 2026-07-18T18:00-04:00 (flyer: SHOW 6PM, explicit year 2026)
- location: "Fountain of the Planets, Flushing Meadows Corona Park, Queens"
- notes: FREE, SummerStage, support from @rajujubrown
- action: "just show up", reminder: July 17, 10 AM

### 6. `IMG_4939.png` — Nando's NYC opening (NY Post carousel, shared to self)
Multi-event + past-date case. Expect FOUR items:
- June 27 watch party → skipped_reason: "past_event" (now = July 3)
- July 2 Nia Archives → skipped_reason: "past_event"
- July 4 & 11 Utopia Bagels collab → caption says "through the 11th" → treat as range: one all-day block July 4–11, both featured dates + hours in notes
- July 9 A$AP Nast performance → event, 12–4 PM
- Screenshot is from user's own story share ("You, 1w ago") — ignore that chrome

## Non-Goals (v1)

- No Instagram API, no bot account, no link scraping
- No user accounts, no history/library UI
- No calendar OAuth or Reminders API — .ics and gcal links only
- No native share-sheet integration (Apple Shortcut wrapper is a v2 add-on hitting the same endpoint)
- No ticket-link resolution or auto-purchase
- No recipe step-by-step formatting (just capture + remind)

## Success Criteria

- ≥ 5/6 test images produce correct type, date, and location with no hallucinated fields
- Screenshot-paste → event on calendar in under 30 seconds including review
- Zero typing required in the happy path (edits optional, not mandatory)

## Later (v2 parking lot)

- Apple Shortcut / share-sheet wrapper hitting the same /api/extract endpoint
- Log every extraction (input hash + output + user correction) → tuning data + case-study research data
- "Was this right?" correction loop in the UI
- IG bot account intake via Meta Messaging API
- Conflict check against calendar before creating
- Weekly digest of un-actioned saves

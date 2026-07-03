# SPEC — "Send to Agent" v1
Instagram post → screenshot → structured action (calendar event / reminder) with zero manual typing.

## Overview

A single stateless serverless endpoint that accepts a screenshot of a social media post (usually Instagram), uses Claude vision to extract actionable intent, and returns structured JSON. An Apple Shortcut consumes the JSON and creates Calendar events / Reminders **on-device**. No accounts, no database, no OAuth.

## User Flow

1. User sees a post in Instagram → takes a screenshot (or shares a link — v1 ignores links, image only)
2. User shares screenshot → runs Shortcut "Send to Agent"
3. Shortcut POSTs base64 image + current datetime + timezone to `/api/extract`
4. Endpoint calls Claude (vision) with a strict extraction prompt
5. Endpoint returns JSON (schema below)
6. Shortcut branches on result and creates Calendar events and/or Reminders natively, then shows a confirmation
7. For dateless items (places, recipes, products): Shortcut shows an "Ask for Input" date prompt pre-filled with the suggested `reminder.date` — user can accept, edit, or skip. Accepted/edited date drives the reminder (and an optional all-day calendar event for places)

## Architecture

- **Runtime:** Vercel serverless function, TypeScript
- **Model:** `claude-sonnet-4-6` via Anthropic Messages API (vision)
- **State:** none. No DB in v1.
- **Auth:** single shared secret header (`x-agent-key`) checked against env var, so the endpoint isn't open to the world
- **Env vars:** `ANTHROPIC_API_KEY`, `AGENT_SHARED_KEY`

## API Contract

### POST `/api/extract`

**Request body:**
```json
{
  "image": "<base64-encoded PNG/JPEG>",
  "media_type": "image/png",
  "now": "2026-07-03T20:15:00-04:00",
  "timezone": "America/New_York",
  "source_url": "https://www.instagram.com/p/... (optional)"
}
```

`now` and `timezone` are REQUIRED. All relative-date resolution depends on them. Reject requests missing them with 400.

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
  "address": "string or null",

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
| `place` | Restaurant/café/shop/venue with an address but NO date | Reminder by default; Shortcut then asks "Pick a date?" — if user picks one, it ALSO creates an all-day calendar event on that date. If skipped, reminder-only with the suggested default date (user can edit in the prompt) |
| `recipe` | Cooking instructions or dish walkthrough | Reminder ("Make X") + ingredients in notes if visible |
| `product` | Item for sale, drop, merch | Reminder with link/handle in notes |
| `other` | Meme, nothing actionable | No reminder. One-line summary only. Never error. |

A post can yield items of MIXED types (e.g., a pop-up shop is an `event` — the date range matters more than the shopping).

## Date & Time Resolution Rules

These are the highest-value rules. Get these wrong and the whole product fails.

1. **Always resolve relative to `now` + `timezone` from the request.** "Next Tuesday, July 7th" → resolve to the concrete date; if the stated weekday and date conflict, TRUST THE EXPLICIT DATE and note the discrepancy in `notes`.
2. **No year stated → assume the next occurrence.** A July 8 post seen on July 3, 2026 means July 8, 2026.
3. **Explicit year stated → use it** (Example 5 says "Saturday July 18 2026").
4. **Date ranges (pop-ups, festivals):** set `start` = opening day, `all_day: true`, `is_date_range: true`, `range_end_date` = final day. The Shortcut creates ONE all-day calendar event spanning the ENTIRE range (start → range_end_date inclusive). Daily hours (e.g., "11AM–8PM") go in `notes`, not as event times. Note for the Shortcut: iOS/EventKit treats all-day end dates as exclusive in some contexts — verify the block visually covers the final day and pad by one day if needed.
5. **Multiple showtimes, same day, same event series** (Example 2: 4 PM + 7 PM films): ONE item, `start` = first showtime, both times in `notes`. Two different films at one movie night = one outing.
6. **Multiple distinct events across dates** (Example 6): separate items, one per date.
7. **Past events relative to `now`:** return the item with `skipped_reason: "past_event"` and `reminder: null`. (Example 6: June 27 and July 2 are past on July 3.)
8. **No time given:** `all_day: true`, and reminder set for 9:00 AM local on the reminder date.
9. **Opening hours ≠ event time.** "Daily 11AM–8PM" is hours, not a start time → all_day visit, hours go in `notes`.

## Reminder Timing Rules

- Ticketed / RSVP events → reminder 3 days before `start`, label includes the action: "RSVP for Rastah pop-up (opens July 8)"
- Free / just-show-up events → reminder at 10:00 AM the day before
- Same-week events (< 3 days away) → reminder tomorrow at 10:00 AM, or in 2 hours if event is tomorrow
- Date-range things (pop-ups) → reminder 2 days after opening: "Rastah pop-up is open — closes July 19"
- Places (no date) → reminder Saturday 11:00 AM of the upcoming weekend: "Try Kaafi — Pakistani café, 109 Ludlow St"
- Recipes → reminder next Sunday 4:00 PM (default cook-something slot)
- Never set a reminder in the past. If computed reminder < `now`, use `now` + 2 hours.

## Image Handling Rules

- Screenshots contain UI chrome (status bar, IG buttons, comment box, nav bar). IGNORE all of it. Never extract "8:11" from the status bar as an event time.
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
- All errors return JSON the Shortcut can read and show

## Test Cases (real screenshots, in /test-images)

### 1. `IMG_4934.png` — Rastah × NYC pop-up (ad)
Flyer + caption both present. Expect ONE item:
- type: event, title: "Rastah NYC Pop-Up"
- is_date_range: true, all_day: true, start: 2026-07-08, range_end_date: 2026-07-19
- Shortcut creates ONE all-day block spanning July 8–19
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
- No date in post → Shortcut prompts with suggested date (upcoming Saturday 11 AM), user can accept/edit/skip
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
- No Android (Apple Shortcuts only)
- No ticket-link resolution or auto-purchase
- No recipe step-by-step formatting (just capture + remind)

## Success Criteria

- ≥ 5/6 test images produce correct type, date, and location with no hallucinated fields
- Round-trip (share → notification confirming creation) under 10 seconds
- Zero manual typing required in the happy path

## Later (v2 parking lot)

- Log every extraction (input hash + output + user correction) → tuning data + case-study research data
- "Was this right?" correction loop in the Shortcut
- IG bot account intake via Meta Messaging API
- Conflict check against calendar before creating
- Weekly digest of un-actioned saves

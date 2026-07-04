# Reel2Real — "Send to Agent" v1

Instagram/TikTok post → structured calendar action, zero manual typing. See
[`SPEC.md`](./SPEC.md) for the full product spec.

This repo is a **backend scaffold**: the `/api/extract` route with request
validation is wired end-to-end, but URL resolution and the Claude call are
**stubbed** so you can run it and fill them in.

## Stack

- Next.js (App Router) on Vercel — one API route (`app/api/extract/route.ts`).
- URL resolution isolated in `lib/resolve.ts` (stub).
- Claude vision extraction in `lib/claude.ts` (stub).
- No DB, no auth, no state (v1).

## Run locally

```bash
npm install
vercel dev          # or: npm run dev
```

Then open http://localhost:3000 and hit `POST /api/extract`.

## API — two stages

Resolution and extraction are separate routes so the frontend can show distinct
progress states and offer the paste fallback while the slow scrape runs.

### `POST /api/resolve` (slow stage, `maxDuration` 60)

```json
{ "url": "https://www.instagram.com/p/..." }
```

Resolves via Apify (Instagram) / oEmbed (TikTok). Per-attempt timeout **25s**
with **one automatic retry on timeout** (worst case ~50s; returns as soon as it
succeeds). Returns the downscaled bundle:

```json
{ "caption": "...", "images": [{ "data": "<base64>", "media_type": "image/jpeg" }],
  "author_handle": "@x", "posted_at": "..." }
```

| Status | Body | When |
| --- | --- | --- |
| 200 | `{ caption, images, author_handle, posted_at }` | success |
| 400 | `{ error, message }` | missing/invalid `url`, bad JSON |
| 422 | `{ error: "resolution_failed" }` | resolution failed/timed out → frontend shows paste fallback |

### `POST /api/extract`

Exactly one source (URL resolution no longer happens here):

```json
{
  "image": "<base64 PNG/JPEG>", "media_type": "image/png",   // screenshot path, OR
  "caption": "...", "images": [{ "data": "...", "media_type": "image/jpeg" }],  // resolved bundle
  "now": "2026-07-03T20:15:00-04:00",
  "timezone": "America/New_York"
}
```

- `now` and `timezone` **required** → 400 if missing.
- Exactly one source (screenshot `image` **or** resolved `images`/`caption`) → 400 if both/neither.
- `media_type` required with `image` → 400.

| Status | Body | When |
| --- | --- | --- |
| 200 | `{ items, post_summary, confidence }` | success |
| 400 | `{ error, message }` | contract violation / bad JSON |
| 502 | `{ error: "extraction_failed" }` | Claude returned unparseable JSON |

### Frontend flow

`app/page.tsx` calls `/api/resolve` then `/api/extract` as two stages with
distinct progress copy ("Resolving link…" → "Reading the post…"). The
screenshot paste/upload fallback is always visible and highlighted while
resolving.

## What's stubbed

- **`lib/resolve.ts`** — throws `ResolutionError` (→ 422). Wire the Instagram
  scraper (`SCRAPER_API_KEY`) and TikTok oEmbed here; keep the
  `{ caption, images, author_handle, posted_at? }` return shape.
- **`lib/claude.ts`** — returns a placeholder `other` item. Wire the Anthropic
  Messages API call (`ANTHROPIC_API_KEY`, model `claude-sonnet-4-6`, vision +
  text, temperature 0, JSON-only output) here.

Copy `.env.example` → `.env.local` and fill in keys before wiring these.

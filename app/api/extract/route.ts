// POST /api/extract — see SPEC.md → "API Contract".
//
// Takes exactly one source (URL resolution now lives in POST /api/resolve):
//   - a pasted screenshot: `image` + `media_type`, OR
//   - a pre-resolved bundle from /api/resolve: `images` and/or `caption`.
// Runs Claude extraction (502 on unparseable output) → 200 { items, ... }.

import { NextResponse } from "next/server";
import { validateExtractRequest } from "@/lib/validate";
import { extract, ClaudeParseError } from "@/lib/claude";
import type {
  ErrorResponse,
  ExtractionInput,
  ExtractResponse,
} from "@/lib/types";

// This route calls the Anthropic API — needs the Node runtime.
export const runtime = "nodejs";
export const maxDuration = 60;

function err(error: string, status: number, message?: string) {
  const body: ErrorResponse = message ? { error, message } : { error };
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  // 1. Parse JSON body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err("invalid_json", 400, "Request body must be valid JSON.");
  }

  // 2. Validate the contract.
  const validated = validateExtractRequest(body);
  if (!validated.ok) {
    return err("invalid_request", 400, validated.error);
  }
  const {
    image,
    media_type,
    caption,
    images,
    is_carousel,
    author_handle,
    posted_at,
    now,
    timezone,
  } = validated.data;

  // 3. Build the extraction input from either the screenshot or the resolved bundle.
  const input: ExtractionInput = image
    ? {
        images: [{ data: image, media_type: media_type as string }],
        is_carousel: false, // a single pasted screenshot is never a carousel
        now,
        timezone,
      }
    : {
        caption,
        images: images ?? [],
        is_carousel: is_carousel ?? false,
        author_handle,
        posted_at,
        now,
        timezone,
      };

  // 4. Run the extraction.
  try {
    const { data, timings } = await extract(input);
    const serverTiming = [
      `downscale;dur=${timings.downscale_ms}`,
      `anthropic;dur=${timings.anthropic_ms}`,
      `geocode;dur=${timings.geocode_ms}`,
      `other;dur=${timings.other_ms}`,
      `total;dur=${timings.total_ms}`,
    ].join(", ");
    return NextResponse.json(data as ExtractResponse, {
      status: 200,
      headers: {
        "Server-Timing": serverTiming,
        "X-Extract-Timings": JSON.stringify(timings),
      },
    });
  } catch (e) {
    if (e instanceof ClaudeParseError) {
      return err("extraction_failed", 502, "Model returned unparseable output.");
    }
    return err("internal_error", 500, "Unexpected error during extraction.");
  }
}

export async function GET() {
  return err("method_not_allowed", 405, "Use POST.");
}

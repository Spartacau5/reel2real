// POST /api/resolve — the slow stage: turn a post URL into caption + images.
// See SPEC.md → "URL Resolution". Split out from /api/extract so the frontend
// can show a distinct "resolving" progress state and offer the screenshot-paste
// fallback while this runs.

import { NextResponse } from "next/server";
import { validateResolveRequest } from "@/lib/validate";
import { resolve, ResolutionError } from "@/lib/resolve";
import { downscaleImages } from "@/lib/image";
import type { ErrorResponse } from "@/lib/types";

export const runtime = "nodejs";
// Worst case: 25s per attempt × 2 attempts + image fetch/downscale. See lib/resolve.ts.
export const maxDuration = 60;

function err(error: string, status: number, message?: string) {
  const body: ErrorResponse = message ? { error, message } : { error };
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err("invalid_json", 400, "Request body must be valid JSON.");
  }

  const validated = validateResolveRequest(body);
  if (!validated.ok) return err("invalid_request", 400, validated.error);

  try {
    const resolved = await resolve(validated.data.url);
    // Downscale to <=1568px long edge before returning (SPEC.md → URL Resolution)
    // so the browser round-trip to /api/extract stays small.
    const images = await downscaleImages(resolved.images);
    return NextResponse.json(
      {
        caption: resolved.caption,
        images,
        author_handle: resolved.author_handle,
        posted_at: resolved.posted_at ?? null,
        is_carousel: resolved.is_carousel ?? false,
        driver: resolved.driver ?? null,
      },
      { status: 200 },
    );
  } catch (e) {
    if (e instanceof ResolutionError) {
      // Frontend shows the screenshot-paste fallback on 422.
      return err("resolution_failed", 422);
    }
    return err("internal_error", 500, "Unexpected error during resolution.");
  }
}

export async function GET() {
  return err("method_not_allowed", 405, "Use POST.");
}

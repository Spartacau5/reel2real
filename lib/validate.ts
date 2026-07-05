// Request validation for POST /api/resolve and POST /api/extract.
// See SPEC.md → "API Contract".
//   /api/resolve:  { url } required.
//   /api/extract:  `now` + `timezone` REQUIRED; exactly one source —
//                  a screenshot (`image` + `media_type`) OR a pre-resolved
//                  bundle (`images` and/or `caption`) from /api/resolve.

import { z } from "zod";
import type { ExtractRequest, ResolveRequest } from "./types";

const ALLOWED_MEDIA_TYPES = ["image/png", "image/jpeg"] as const;

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function firstError<T>(parsed: z.SafeParseReturnType<unknown, T>): ValidationResult<T> {
  if (parsed.success) return { ok: true, data: parsed.data };
  const first = parsed.error.issues[0];
  return { ok: false, error: first?.message ?? "Invalid request." };
}

// ── /api/resolve ───────────────────────────────────────────────────────────

const resolveSchema = z.object({
  url: z
    .string({ required_error: "url is required" })
    .url("url must be a valid URL"),
});

export function validateResolveRequest(body: unknown): ValidationResult<ResolveRequest> {
  return firstError(resolveSchema.safeParse(body));
}

// ── /api/extract ─────────────────────────────────────────────────────────

const encodedImage = z.object({
  data: z.string().min(1),
  media_type: z.string().min(1),
});

const extractSchema = z
  .object({
    image: z.string().min(1).optional(),
    media_type: z.enum(ALLOWED_MEDIA_TYPES).optional(),
    caption: z.string().optional(),
    images: z.array(encodedImage).optional(),
    is_carousel: z.boolean().optional(),
    author_handle: z.string().optional(),
    posted_at: z.string().optional(),
    now: z.string({ required_error: "now is required" }).min(1, "now is required"),
    timezone: z
      .string({ required_error: "timezone is required" })
      .min(1, "timezone is required"),
  })
  .superRefine((val, ctx) => {
    const hasScreenshot = typeof val.image === "string" && val.image.length > 0;
    const hasResolved =
      (Array.isArray(val.images) && val.images.length > 0) ||
      (typeof val.caption === "string" && val.caption.length > 0);

    // Exactly one source.
    if (hasScreenshot && hasResolved) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide exactly one source: a screenshot (`image`) or a resolved bundle (`images`/`caption`), not both.",
      });
    }
    if (!hasScreenshot && !hasResolved) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A source is required: a screenshot (`image` + `media_type`) or a resolved bundle (`images`/`caption`).",
      });
    }

    // media_type is required with a screenshot.
    if (hasScreenshot && !val.media_type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["media_type"],
        message: "media_type is required when `image` is provided.",
      });
    }

    // `now` must parse as a real instant.
    if (val.now && Number.isNaN(Date.parse(val.now))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["now"],
        message: "now must be an ISO 8601 datetime with a timezone offset.",
      });
    }
  });

export function validateExtractRequest(body: unknown): ValidationResult<ExtractRequest> {
  return firstError(extractSchema.safeParse(body) as z.SafeParseReturnType<unknown, ExtractRequest>);
}

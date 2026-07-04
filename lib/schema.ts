// Zod schema for validating Claude's extraction output against the Item schema.
// See SPEC.md → "Item schema". Used for the "validate with zod and retry once
// on parse failure" path (SPEC.md → System Prompt Requirements).

import { z } from "zod";

export const itemSchema = z.object({
  type: z.enum(["event", "place", "recipe", "product", "other"]),
  title: z.string(),
  notes: z.string(),

  // EVENT fields (null for other types)
  start: z.string().nullable(),
  end: z.string().nullable(),
  all_day: z.boolean(),
  is_date_range: z.boolean(),
  range_end_date: z.string().nullable(),
  location: z.string().nullable(),
  action: z.string(),

  // PLACE fields
  place_name: z.string().nullable(),
  address: z.string().nullable(),

  // Location enrichment — added in post-processing; the model doesn't emit
  // these, so they're optional/defaulted here.
  resolved_address: z.string().nullable().default(null),
  address_source: z.enum(["stated", "resolved"]).nullable().default(null),
  maps_url: z.string().nullable().default(null),

  // REMINDER suggestion (all types)
  reminder: z
    .object({
      date: z.string(),
      label: z.string(),
    })
    .nullable(),

  skipped_reason: z
    .enum(["past_event", "insufficient_info", "unreadable"])
    .nullable(),
});

export const extractResponseSchema = z.object({
  items: z.array(itemSchema),
  post_summary: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
});

export type ParsedExtractResponse = z.infer<typeof extractResponseSchema>;

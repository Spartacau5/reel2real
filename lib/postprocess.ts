// Deterministic post-processing — see SPEC.md → Post-Processing (deterministic).
// Past-event detection is done in code, NOT by the model: after extraction we
// set skipped_reason="past_event" wherever an event's date is before `now`.
// This is authoritative — it also clears a past_event the model set by mistake
// on a future event.

import type { Item } from "./types";

/**
 * Mark every event that has already happened as past, and clear reminders on it.
 * Rules:
 *   - Date-range item: past only once the whole range has ended (range_end_date < today).
 *   - All-day item: past when its date is before today.
 *   - Timed item: past when its start datetime is before now (includes earlier today).
 * Items with no date (places, recipes, products, other) are never past.
 */
export function markPastEvents(items: Item[], now: string): Item[] {
  const nowMs = Date.parse(now);
  const nowDate = now.slice(0, 10); // YYYY-MM-DD in the request's offset

  return items.map((item) => {
    if (isPast(item, nowMs, nowDate)) {
      return { ...item, skipped_reason: "past_event", reminder: null };
    }
    // Code is the authority on past events — undo a wrong model guess.
    if (item.skipped_reason === "past_event") {
      return { ...item, skipped_reason: null };
    }
    return item;
  });
}

function isPast(item: Item, nowMs: number, nowDate: string): boolean {
  // ISO date strings (YYYY-MM-DD) sort lexically, so string comparison is safe.
  if (item.is_date_range && item.range_end_date) {
    return item.range_end_date < nowDate;
  }
  if (!item.start) return false;
  if (item.all_day) {
    return item.start.slice(0, 10) < nowDate;
  }
  const startMs = Date.parse(item.start);
  return !Number.isNaN(startMs) && startMs < nowMs;
}

// Client-side calendar generation: .ics files (RFC 5545) and Google Calendar
// template links. Pure functions — safe to import in a client component.
//
// KEY RULE (SPEC.md → Date & Time #4): DTEND for all-day events is EXCLUSIVE
// per RFC 5545, so DTEND = last day + 1. A single all-day event on July 8 has
// DTEND July 9; a range July 8–19 has DTEND July 20. Google Calendar's all-day
// `dates` param uses the same exclusive end.

export interface CalItem {
  title: string;
  location: string;
  notes: string;
  allDay: boolean;
  isDateRange: boolean;
  offset: string; // e.g. "-04:00" or "Z" — timezone for timed events
  dateStart: string; // "YYYY-MM-DD" (all-day / range start)
  dateEnd: string; // "YYYY-MM-DD" (range end, inclusive) — "" if none
  timeStart: string; // "YYYY-MM-DDTHH:MM" (timed start) — "" if all-day
  timeEnd: string; // "YYYY-MM-DDTHH:MM" (timed end) — "" → default +1h
  reminderLocal: string; // "YYYY-MM-DDTHH:MM" absolute alarm time — "" if none
  reminderLabel: string;
}

// ── date helpers ────────────────────────────────────────────────────────────

/** "YYYY-MM-DD" → "YYYYMMDD" */
function ymd(d: string): string {
  return d.replace(/-/g, "");
}

/** Add n days to "YYYY-MM-DD", return "YYYYMMDD". Used for exclusive DTEND. */
function addDays(d: string, n: number): string {
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/** Local wall time + offset → UTC basic stamp "YYYYMMDDTHHMMSSZ". */
function utcStamp(local: string, offset: string, addMs = 0): string {
  const iso = `${local}:00${offset === "Z" ? "Z" : offset}`;
  const t = new Date(new Date(iso).getTime() + addMs);
  return t.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// ── ICS ─────────────────────────────────────────────────────────────────────

/** Escape a value for an ICS text field (RFC 5545 §3.3.11). */
function esc(s: string): string {
  return (s || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold a content line to <=75 octets with CRLF + space continuation. */
function fold(line: string): string {
  if (line.length <= 73) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 73));
  rest = rest.slice(73);
  while (rest.length > 72) {
    parts.push(" " + rest.slice(0, 72));
    rest = rest.slice(72);
  }
  if (rest.length) parts.push(" " + rest);
  return parts.join("\r\n");
}

function dtStartEnd(item: CalItem): string[] {
  if (item.allDay) {
    const startD = ymd(item.dateStart);
    const endBase =
      item.isDateRange && item.dateEnd ? item.dateEnd : item.dateStart;
    const endD = addDays(endBase, 1); // EXCLUSIVE end
    return [`DTSTART;VALUE=DATE:${startD}`, `DTEND;VALUE=DATE:${endD}`];
  }
  const start = utcStamp(item.timeStart, item.offset);
  const end = item.timeEnd
    ? utcStamp(item.timeEnd, item.offset)
    : utcStamp(item.timeStart, item.offset, 60 * 60 * 1000); // default +1h
  return [`DTSTART:${start}`, `DTEND:${end}`];
}

/** Build a full VCALENDAR string for one item. */
export function buildICS(item: CalItem): string {
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@reel2real`;
  const [dtstart, dtend] = dtStartEnd(item);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Reel2Real//Send to Agent//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `SUMMARY:${esc(item.title)}`,
    dtstart,
    dtend,
  ];
  if (item.location) lines.push(`LOCATION:${esc(item.location)}`);
  if (item.notes) lines.push(`DESCRIPTION:${esc(item.notes)}`);

  if (item.reminderLocal) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${esc(item.reminderLabel || item.title)}`,
      `TRIGGER;VALUE=DATE-TIME:${utcStamp(item.reminderLocal, item.offset)}`,
      "END:VALARM",
    );
  }

  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n");
}

/**
 * A `data:` URI for the .ics. Rendered as the href of a real <a download>, which
 * is the reliable "add to calendar" path on iOS Safari (a native tap → Calendar).
 */
export function icsDataUri(item: CalItem): string {
  return "data:text/calendar;charset=utf-8," + encodeURIComponent(buildICS(item));
}

// ── Google Calendar link ─────────────────────────────────────────────────────

/** Prefilled Google Calendar "TEMPLATE" URL (no OAuth). */
export function googleCalUrl(item: CalItem): string {
  let dates: string;
  if (item.allDay) {
    const startD = ymd(item.dateStart);
    const endBase =
      item.isDateRange && item.dateEnd ? item.dateEnd : item.dateStart;
    dates = `${startD}/${addDays(endBase, 1)}`; // exclusive end, same rule
  } else {
    const start = utcStamp(item.timeStart, item.offset);
    const end = item.timeEnd
      ? utcStamp(item.timeEnd, item.offset)
      : utcStamp(item.timeStart, item.offset, 60 * 60 * 1000);
    dates = `${start}/${end}`;
  }
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: item.title,
    dates,
  });
  if (item.notes) p.set("details", item.notes);
  if (item.location) p.set("location", item.location);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

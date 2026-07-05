// GET /api/ics — generate an .ics from query params and serve it as
// `text/calendar` with INLINE disposition. Served over HTTPS this way, iOS
// Safari hands the event to Calendar (a `data:` URI instead saves to Files).
//
// The card links here with the event fields as query params (see lib/calendar
// → icsHref). Reuses buildICS so client and server produce identical output.

import { buildICS, calItemFromParams } from "@/lib/calendar";

export const runtime = "nodejs";

export function GET(req: Request) {
  const item = calItemFromParams(new URL(req.url).searchParams);

  // A valid event needs at least a start (a date for all-day, a datetime for timed).
  const missingDate = item.allDay ? !item.dateStart : !item.timeStart;
  if (missingDate) {
    return new Response("Missing event date.", { status: 400 });
  }

  const ics = buildICS(item);
  const filename =
    (item.title || "event").replace(/[^\w -]+/g, "").trim().slice(0, 40) || "event";

  return new Response(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="${filename}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}

"use client";

// Single-page "Send to Agent" UI (SPEC.md → User Flow / Frontend requirements).
// Mobile-first, iPhone Safari primary.
//
// Flow:  ?url= auto-submit → RESOLVE (/api/resolve) → EXTRACT (/api/extract)
//        → editable review cards → .ics download / Google Calendar link.
// Fallback: paste / upload / drag-drop a screenshot at any time.
// States: idle(empty) · resolving · extracting · results · error-with-fallback.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ExtractResponse, Item } from "@/lib/types";
import { icsHref, googleCalUrl, type CalItem } from "@/lib/calendar";

type Stage = "idle" | "resolving" | "extracting" | "results" | "error";

interface ResolveResult {
  caption: string;
  images: Array<{ data: string; media_type: string }>;
  author_handle: string;
  posted_at: string | null;
  is_carousel: boolean;
}

// ── time / tz helpers ────────────────────────────────────────────────────────

function pad(n: number) {
  return String(Math.floor(Math.abs(n))).padStart(2, "0");
}
function browserOffset(): string {
  const o = -new Date().getTimezoneOffset();
  return `${o >= 0 ? "+" : "-"}${pad(o / 60)}:${pad(o % 60)}`;
}
function localNowIso(): string {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
  return `${local}${browserOffset()}`;
}
function timezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
function extractOffset(iso?: string | null): string | null {
  const m = iso?.match(/([+-]\d{2}:\d{2}|Z)$/);
  return m ? m[1] : null;
}

// ── client-side downscale (canvas, max 1568px long edge) ─────────────────────

async function downscaleClient(
  file: File,
): Promise<{ data: string; media_type: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
    const max = 1568;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas context");
    ctx.drawImage(img, 0, 0, w, h);
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    const dataUrl = canvas.toDataURL(type, 0.9);
    return { data: dataUrl.split(",")[1], media_type: type };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── editable card model ──────────────────────────────────────────────────────

interface Card {
  id: number;
  type: Item["type"];
  title: string;
  notes: string;
  location: string;
  allDay: boolean;
  isDateRange: boolean;
  dateStart: string; // YYYY-MM-DD
  dateEnd: string; // YYYY-MM-DD (range end, inclusive)
  timeStart: string; // YYYY-MM-DDTHH:MM
  timeEnd: string; // YYYY-MM-DDTHH:MM
  reminderLocal: string; // YYYY-MM-DDTHH:MM
  reminderLabel: string;
  offset: string;
  dateless: boolean;
  skip: boolean; // dateless: reminder-only, no calendar add
  past: boolean;
  unreadable: boolean;
  resolved_address: string | null;
  address_source: string | null;
  maps_url: string | null;
}

function fromItem(item: Item, id: number): Card {
  const offset =
    extractOffset(item.start) ||
    extractOffset(item.reminder?.date) ||
    browserOffset();
  const hasRange = item.is_date_range && !!item.range_end_date;
  const dateless = !item.start && !hasRange;

  let allDay = item.all_day;
  let dateStart = "";
  let timeStart = "";
  if (item.start) {
    dateStart = item.start.slice(0, 10);
    if (!allDay) timeStart = item.start.slice(0, 16);
  }
  if (dateless) {
    allDay = true; // dateless → suggest an all-day event on the reminder date
    dateStart = (item.reminder?.date || localNowIso()).slice(0, 10);
  }

  return {
    id,
    type: item.type,
    title: item.title,
    notes: item.notes,
    location: item.location || item.address || item.place_name || "",
    allDay,
    isDateRange: hasRange,
    dateStart,
    dateEnd: item.range_end_date || "",
    timeStart,
    timeEnd: item.end ? item.end.slice(0, 16) : "",
    reminderLocal: item.reminder ? item.reminder.date.slice(0, 16) : "",
    reminderLabel: item.reminder?.label || item.title,
    offset,
    dateless,
    skip: false,
    past: item.skipped_reason === "past_event",
    unreadable: item.skipped_reason === "unreadable",
    resolved_address: item.resolved_address,
    address_source: item.address_source,
    maps_url: item.maps_url,
  };
}

function toCalItem(c: Card): CalItem {
  return {
    title: c.title,
    location: c.location,
    notes: c.notes,
    allDay: c.allDay,
    isDateRange: c.isDateRange,
    offset: c.offset,
    dateStart: c.dateStart,
    dateEnd: c.dateEnd,
    timeStart: c.timeStart,
    timeEnd: c.timeEnd,
    reminderLocal: c.reminderLocal,
    reminderLabel: c.reminderLabel,
  };
}

// ── styles ───────────────────────────────────────────────────────────────────

const input: React.CSSProperties = {
  width: "100%",
  padding: "0.55rem 0.65rem",
  border: "1px solid #ccc",
  borderRadius: 8,
  fontSize: 16, // 16px avoids iOS Safari zoom-on-focus
  boxSizing: "border-box",
  background: "#fff",
};
const label: React.CSSProperties = {
  fontSize: "0.72rem",
  color: "#888",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  marginBottom: 3,
  display: "block",
};

// ── page ─────────────────────────────────────────────────────────────────────

export default function Home() {
  const [stage, setStage] = useState<Stage>("idle");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<string | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [processing, setProcessing] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // The resolved post, shown as a preview the moment /api/resolve returns —
  // before extraction finishes — so the user sees "it caught my post" fast.
  const [preview, setPreview] = useState<{
    thumbnail?: string;
    author_handle?: string;
    caption?: string;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const setResult = useCallback((r: ExtractResponse) => {
    setSummary(r.post_summary);
    setConfidence(r.confidence);
    setCards(r.items.map((it, i) => fromItem(it, i)));
    setPreview(null); // real cards replace the preview + skeletons
    setStage("results");
  }, []);

  const runExtract = useCallback(
    async (payload: Record<string, unknown>) => {
      setStage("extracting");
      setError(null);
      try {
        const res = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...payload,
            now: localNowIso(),
            timezone: timezone(),
          }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          setError(b.message || b.error || "Extraction failed.");
          setStage("error");
          return;
        }
        setResult((await res.json()) as ExtractResponse);
      } catch {
        setError("Network error during extraction.");
        setStage("error");
      }
    },
    [setResult],
  );

  const submitUrl = useCallback(
    async (u: string) => {
      const target = u.trim();
      if (!target) return;
      setProcessing(target);
      setCards([]);
      setPreview(null);
      setError(null);
      setStage("resolving");
      try {
        const res = await fetch("/api/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: target }),
        });
        if (!res.ok) {
          setError("Couldn’t read that link. Paste a screenshot instead.");
          setStage("error");
          return;
        }
        const resolved = (await res.json()) as ResolveResult;
        // Render the resolved post immediately — extraction continues below.
        const thumb = resolved.images?.[0];
        setPreview({
          thumbnail: thumb
            ? `data:${thumb.media_type};base64,${thumb.data}`
            : undefined,
          author_handle: resolved.author_handle,
          caption: resolved.caption,
        });
        await runExtract({
          caption: resolved.caption,
          images: resolved.images,
          is_carousel: resolved.is_carousel,
          author_handle: resolved.author_handle,
          posted_at: resolved.posted_at ?? undefined,
        });
      } catch {
        setError("Couldn’t reach that link. Paste a screenshot instead.");
        setStage("error");
      }
    },
    [runExtract],
  );

  const onScreenshot = useCallback(
    async (file: File) => {
      setProcessing("your screenshot");
      setCards([]);
      const img = await downscaleClient(file);
      setPreview({ thumbnail: `data:${img.media_type};base64,${img.data}` });
      await runExtract({ image: img.data, media_type: img.media_type });
    },
    [runExtract],
  );

  // Auto-submit on ?url= (iOS Shortcut / deep-link entry).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("url");
    if (q) {
      setUrl(q);
      void submitUrl(q);
    }
  }, [submitUrl]);

  // Paste a screenshot from the clipboard, at any time.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) =>
        i.type.startsWith("image/"),
      );
      const f = item?.getAsFile();
      if (f) void onScreenshot(f);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onScreenshot]);

  const busy = stage === "resolving" || stage === "extracting";
  const updateCard = (id: number, patch: Partial<Card>) =>
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "1.75rem 1rem 4rem" }}>
      <style>{`
        .sk{background:#ececec;border-radius:6px;animation:r2rpulse 1.2s ease-in-out infinite}
        @keyframes r2rpulse{0%,100%{opacity:1}50%{opacity:.45}}
      `}</style>
      <h1 style={{ margin: "0 0 0.15rem", fontSize: "1.4rem" }}>Send to Agent</h1>
      <p style={{ color: "#666", marginTop: 0, fontSize: "0.9rem" }}>
        Paste an Instagram/TikTok link — get a calendar event, no typing.
      </p>

      {/* URL field */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submitUrl(url);
        }}
        style={{ display: "flex", gap: 8, marginTop: "1rem" }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.instagram.com/p/…"
          disabled={busy}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          style={{ ...input, flex: 1 }}
        />
        <button
          type="submit"
          disabled={busy || !url.trim()}
          style={{
            padding: "0 1.1rem",
            borderRadius: 8,
            border: "none",
            background: busy || !url.trim() ? "#bbb" : "#111",
            color: "#fff",
            fontWeight: 600,
            fontSize: 16,
          }}
        >
          Go
        </button>
      </form>

      {/* Stage 1: resolving the link (no preview yet). */}
      {stage === "resolving" && (
        <Progress
          title="Resolving link…"
          detail={`Fetching the post${processing ? ` — ${short(processing)}` : ""}. This can take a moment.`}
        />
      )}

      {/* Stage 2: post caught → show the resolved preview + skeleton cards while
          /api/extract runs. The user sees "it caught my post" within ~3s. */}
      {stage === "extracting" && (
        <section style={{ marginTop: "1rem" }}>
          {preview && <ResolvedPreview {...preview} />}
          <SkeletonCards count={2} />
        </section>
      )}

      {/* Error with fallback emphasis */}
      {stage === "error" && error && (
        <div
          style={{
            marginTop: "1rem",
            padding: "0.9rem 1rem",
            background: "#fdecea",
            border: "1px solid #f5c6cb",
            borderRadius: 10,
            color: "#8a1c1c",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </div>
      )}

      {/* Results */}
      {stage === "results" && (
        <section style={{ marginTop: "1.25rem" }}>
          {summary && (
            <p style={{ color: "#444", fontSize: "0.88rem" }}>
              {summary}{" "}
              <span style={{ color: "#aaa" }}>· confidence {confidence}</span>
            </p>
          )}
          {cards.map((c) => (
            <CardView
              key={c.id}
              card={c}
              onChange={(patch) => updateCard(c.id, patch)}
              onRetryScreenshot={() => fileRef.current?.click()}
            />
          ))}
        </section>
      )}

      {/* Always-visible screenshot fallback: paste / upload / drag-drop */}
      <section
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f && f.type.startsWith("image/")) void onScreenshot(f);
        }}
        style={{
          marginTop: "1.75rem",
          padding: "1rem",
          borderTop: "1px solid #eee",
          borderRadius: 10,
          background: dragging ? "#eef4ff" : "transparent",
          outline: dragging ? "2px dashed #6a9bff" : "none",
        }}
      >
        <div style={{ fontSize: "0.82rem", color: "#666", marginBottom: 8 }}>
          {stage === "resolving"
            ? "Taking a while? Paste a screenshot instead —"
            : "Or paste / upload / drag a screenshot"}
        </div>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={stage === "extracting"}
          style={{
            padding: "0.6rem 1rem",
            borderRadius: 8,
            border: "1px dashed #aaa",
            background: "#fafafa",
            fontSize: 15,
            width: "100%",
          }}
        >
          Choose screenshot… (or ⌘/Ctrl+V to paste)
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onScreenshot(f);
          }}
        />
      </section>
    </main>
  );
}

function short(u: string): string {
  return u.length > 44 ? u.slice(0, 41) + "…" : u;
}

function Progress({ title, detail }: { title: string; detail: string }) {
  return (
    <div
      style={{
        marginTop: "1rem",
        padding: "0.9rem 1rem",
        background: "#f4f7ff",
        border: "1px solid #d6e0ff",
        borderRadius: 10,
      }}
    >
      <div style={{ fontWeight: 600 }}>{title}</div>
      <div style={{ color: "#555", fontSize: "0.88rem", marginTop: 2 }}>{detail}</div>
    </div>
  );
}

// The resolved post, shown the instant /api/resolve returns — "it caught my post".
function ResolvedPreview({
  thumbnail,
  author_handle,
  caption,
}: {
  thumbnail?: string;
  author_handle?: string;
  caption?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "0.85rem",
        border: "1px solid #d8ecdc",
        background: "#f3fbf5",
        borderRadius: 12,
      }}
    >
      {thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbnail}
          alt=""
          style={{
            width: 60,
            height: 60,
            objectFit: "cover",
            borderRadius: 8,
            flexShrink: 0,
          }}
        />
      ) : (
        <div className="sk" style={{ width: 60, height: 60, flexShrink: 0 }} />
      )}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
          ✓ Got it{author_handle ? ` — ${author_handle}` : ""}
          <span style={{ color: "#3a8", fontWeight: 500 }}> · reading the post…</span>
        </div>
        {caption && (
          <div
            style={{
              fontSize: "0.8rem",
              color: "#556",
              marginTop: 4,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {caption}
          </div>
        )}
      </div>
    </div>
  );
}

// Placeholder cards shown while extraction runs.
function SkeletonCards({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ ...card, marginTop: "0.85rem" }}>
          <div className="sk" style={{ height: 12, width: "22%" }} />
          <div className="sk" style={{ height: 16, width: "70%", marginTop: 10 }} />
          <div className="sk" style={{ height: 12, width: "45%", marginTop: 10 }} />
          <div className="sk" style={{ height: 12, width: "85%", marginTop: 10 }} />
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <div className="sk" style={{ height: 38, flex: 1 }} />
            <div className="sk" style={{ height: 38, flex: 1 }} />
          </div>
        </div>
      ))}
    </>
  );
}

// ── card ─────────────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  border: "1px solid #e3e3e3",
  borderRadius: 12,
  padding: "1rem",
  marginTop: "0.85rem",
};

function CardView({
  card: c,
  onChange,
  onRetryScreenshot,
}: {
  card: Card;
  onChange: (patch: Partial<Card>) => void;
  onRetryScreenshot: () => void;
}) {
  // Unreadable → recovery affordance, primary action is the paste fallback.
  if (c.unreadable) {
    return (
      <div style={{ ...card, background: "#fff9ec", border: "1px solid #f0d8a8" }}>
        <strong>Couldn’t read this post</strong>
        <div style={{ fontSize: "0.85rem", color: "#6b5a30", marginTop: 4 }}>
          A screenshot of the post usually works better.
        </div>
        <button
          onClick={onRetryScreenshot}
          style={{
            marginTop: "0.7rem",
            padding: "0.55rem 1rem",
            borderRadius: 8,
            border: "none",
            background: "#111",
            color: "#fff",
            fontWeight: 600,
            fontSize: 15,
          }}
        >
          Paste or upload a screenshot
        </button>
      </div>
    );
  }

  // Past event → greyed out, no actions.
  if (c.past) {
    return (
      <div style={{ ...card, opacity: 0.5 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <strong>{c.title}</strong>
          <span style={{ fontSize: "0.68rem", color: "#a00" }}>PAST EVENT</span>
        </div>
        {c.dateStart && (
          <div style={{ fontSize: "0.82rem", color: "#666", marginTop: 4 }}>
            🗓 {c.timeStart || c.dateStart}
          </div>
        )}
        {c.location && (
          <div style={{ fontSize: "0.82rem", color: "#666", marginTop: 2 }}>
            📍 {c.location}
          </div>
        )}
      </div>
    );
  }

  // "other" with no venue/date → summary only, no calendar affordance.
  const nothingActionable =
    c.type === "other" && !c.location && !c.dateStart && !c.timeStart;
  if (nothingActionable) {
    return (
      <div style={{ ...card }}>
        <strong>{c.title}</strong>
        {c.notes && (
          <div style={{ fontSize: "0.82rem", color: "#666", marginTop: 6 }}>
            {c.notes}
          </div>
        )}
      </div>
    );
  }

  const cal = toCalItem(c);
  const showCalendar = !(c.dateless && c.skip);

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: "0.68rem", color: "#999", textTransform: "uppercase" }}>
          {c.type}
        </span>
      </div>

      {/* Title */}
      <div style={{ marginTop: 4 }}>
        <label style={label}>Title</label>
        <input
          value={c.title}
          onChange={(e) => onChange({ title: e.target.value })}
          style={input}
        />
      </div>

      {/* Dateless prompt (place / recipe / product) */}
      {c.dateless && (
        <div
          style={{
            marginTop: 10,
            fontSize: "0.8rem",
            color: "#555",
            background: "#f7f7f7",
            padding: "0.5rem 0.6rem",
            borderRadius: 8,
          }}
        >
          No date in this post — pick one to add an all-day reminder, or skip.
          <label style={{ marginLeft: 8 }}>
            <input
              type="checkbox"
              checked={c.skip}
              onChange={(e) => onChange({ skip: e.target.checked })}
            />{" "}
            skip (reminder only)
          </label>
        </div>
      )}

      {/* Date/time — all-day vs timed */}
      {!c.dateless && (
        <label style={{ display: "block", marginTop: 10, fontSize: "0.8rem", color: "#555" }}>
          <input
            type="checkbox"
            checked={c.allDay}
            onChange={(e) => onChange({ allDay: e.target.checked })}
          />{" "}
          all-day
        </label>
      )}

      {c.allDay ? (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={label}>{c.isDateRange ? "Start day" : "Day"}</label>
            <input
              type="date"
              value={c.dateStart}
              onChange={(e) => onChange({ dateStart: e.target.value })}
              style={input}
            />
          </div>
          {c.isDateRange && (
            <div style={{ flex: 1 }}>
              <label style={label}>End day (incl.)</label>
              <input
                type="date"
                value={c.dateEnd}
                onChange={(e) => onChange({ dateEnd: e.target.value })}
                style={input}
              />
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={label}>Start</label>
            <input
              type="datetime-local"
              value={c.timeStart}
              onChange={(e) => onChange({ timeStart: e.target.value })}
              style={input}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={label}>End (optional)</label>
            <input
              type="datetime-local"
              value={c.timeEnd}
              onChange={(e) => onChange({ timeEnd: e.target.value })}
              style={input}
            />
          </div>
        </div>
      )}

      {/* Location */}
      <div style={{ marginTop: 10 }}>
        <label style={label}>Location</label>
        <input
          value={c.location}
          onChange={(e) => onChange({ location: e.target.value })}
          style={input}
        />
        {c.address_source === "resolved" && c.resolved_address && (
          <div style={{ fontSize: "0.76rem", color: "#777", marginTop: 4 }}>
            ✅ {c.resolved_address}
            {c.resolved_address !== c.location && (
              <button
                onClick={() => onChange({ location: c.resolved_address! })}
                style={{
                  marginLeft: 8,
                  fontSize: "0.74rem",
                  border: "1px solid #ccc",
                  borderRadius: 6,
                  background: "#fff",
                  padding: "1px 6px",
                }}
              >
                use
              </button>
            )}
            {c.maps_url && (
              <>
                {" · "}
                <a href={c.maps_url} target="_blank" rel="noreferrer">
                  Maps
                </a>
              </>
            )}
          </div>
        )}
      </div>

      {/* Notes */}
      <div style={{ marginTop: 10 }}>
        <label style={label}>Notes</label>
        <textarea
          value={c.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
          rows={3}
          style={{ ...input, resize: "vertical", fontFamily: "inherit" }}
        />
      </div>

      {/* Reminder */}
      <div style={{ marginTop: 10 }}>
        <label style={label}>Reminder</label>
        <input
          type="datetime-local"
          value={c.reminderLocal}
          onChange={(e) => onChange({ reminderLocal: e.target.value })}
          style={input}
        />
      </div>

      {/* Actions */}
      {showCalendar ? (
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <a
            href={icsHref(cal)}
            style={{
              flex: 1,
              textAlign: "center",
              padding: "0.6rem",
              borderRadius: 8,
              background: "#111",
              color: "#fff",
              fontWeight: 600,
              textDecoration: "none",
              fontSize: 15,
            }}
          >
            Apple Calendar
          </a>
          <a
            href={googleCalUrl(cal)}
            target="_blank"
            rel="noreferrer"
            style={{
              flex: 1,
              textAlign: "center",
              padding: "0.6rem",
              borderRadius: 8,
              border: "1px solid #111",
              color: "#111",
              fontWeight: 600,
              textDecoration: "none",
              fontSize: 15,
            }}
          >
            Google Calendar
          </a>
        </div>
      ) : (
        <div style={{ marginTop: 14, fontSize: "0.82rem", color: "#3a6" }}>
          🔔 Reminder only — {c.reminderLabel}
        </div>
      )}
    </div>
  );
}

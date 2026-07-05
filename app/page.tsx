"use client";

// Reel2Real — single page, mobile-first (iPhone Safari primary).
// Flow: ?url= auto-submit → RESOLVE → EXTRACT → editable review cards →
// .ics / Google Calendar. Fallback: paste / upload / drag a screenshot.
// All visual tokens live in app/globals.css (the design system).

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
    return { data: canvas.toDataURL(type, 0.9).split(",")[1], media_type: type };
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
  dateEnd: string;
  timeStart: string; // YYYY-MM-DDTHH:MM
  timeEnd: string;
  reminderLocal: string;
  reminderLabel: string;
  offset: string;
  dateless: boolean;
  skip: boolean;
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
    allDay = true;
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

// ── date formatting (read mode) ──────────────────────────────────────────────

function fmtDay(d: string): string {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
function fmtTime(local: string): string {
  if (!local) return "";
  return new Date(local).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
function dateLine(c: Card): string {
  if (c.allDay) {
    if (c.isDateRange && c.dateEnd) return `${fmtDay(c.dateStart)} – ${fmtDay(c.dateEnd)}`;
    return `${fmtDay(c.dateStart)} · all day`;
  }
  const te = c.timeEnd ? `–${fmtTime(c.timeEnd)}` : "";
  return `${fmtDay(c.dateStart)} · ${fmtTime(c.timeStart)}${te}`;
}
function short(u: string): string {
  return u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

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
    setPreview(null);
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
          body: JSON.stringify({ ...payload, now: localNowIso(), timezone: timezone() }),
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
          setError("Couldn’t read that link. Try a screenshot instead.");
          setStage("error");
          return;
        }
        const resolved = (await res.json()) as ResolveResult;
        const thumb = resolved.images?.[0];
        setPreview({
          thumbnail: thumb ? `data:${thumb.media_type};base64,${thumb.data}` : undefined,
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
        setError("Couldn’t reach that link. Try a screenshot instead.");
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

  // Paste a screenshot from the clipboard, any time.
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

  const urlForm = (
    <form
      className="url-row"
      onSubmit={(e) => {
        e.preventDefault();
        void submitUrl(url);
      }}
    >
      <input
        className="url-input"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="instagram.com/p/…"
        disabled={busy}
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
      />
      <button
        type="submit"
        className="btn btn-primary"
        disabled={busy || !url.trim()}
        style={{ flex: "0 0 auto", padding: "0 18px" }}
      >
        Go
      </button>
    </form>
  );

  const pasteZone = (
    <button className="paste" onClick={() => fileRef.current?.click()}>
      Drop a screenshot, or tap to upload
      <div className="paste-sub">paste with ⌘/Ctrl+V, or drag it here</div>
    </button>
  );

  return (
    <main className="app">
      <header className="header">
        <h1 className="display">Reel2Real</h1>
        <p className="tagline">From your feed to your calendar.</p>
      </header>

      {/* Empty state — one unified action area */}
      {stage === "idle" && (
        <>
          <div
            className={`action${dragging ? " dragging" : ""}`}
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
          >
            <p className="action-copy">
              Paste an Instagram or TikTok link — or drop a screenshot
            </p>
            {urlForm}
            <div className="divider">or</div>
            {pasteZone}
          </div>
          <p className="tip">
            Tip: share straight from Instagram via the Reel2Real shortcut
          </p>
        </>
      )}

      {/* Persistent URL field for a new post in every other state */}
      {stage !== "idle" && urlForm}

      {/* Resolving — the link as a breathing chip */}
      {stage === "resolving" && (
        <>
          <div className="chip">
            <span className="chip-dot" />
            <span className="chip-url">{short(processing || "")}</span>
          </div>
          <div className="alt">
            <div className="alt-label">Taking a moment? Paste a screenshot instead</div>
            {pasteZone}
          </div>
        </>
      )}

      {/* Preview + skeletons — the "caught it" moment */}
      {stage === "extracting" && (
        <section>
          {preview && (
            <div className="card preview rise">
              {preview.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="preview-thumb" src={preview.thumbnail} alt="" />
              ) : (
                <div className="preview-thumb sk" />
              )}
              <div className="preview-body">
                <div className="preview-handle">
                  {preview.author_handle || "Your post"}
                </div>
                <div className="preview-status">Got it — reading the post…</div>
                {preview.caption && (
                  <div className="preview-caption">{preview.caption}</div>
                )}
              </div>
            </div>
          )}
          <SkeletonCard />
          <SkeletonCard />
        </section>
      )}

      {/* Error — calm, with a screenshot path */}
      {stage === "error" && error && (
        <>
          <div className="notice">{error}</div>
          <div className="alt">
            <div className="alt-label">Try a screenshot instead</div>
            {pasteZone}
          </div>
        </>
      )}

      {/* Results */}
      {stage === "results" && (
        <section>
          {summary && (
            <p className="summary">
              {summary} <span className="conf">· {confidence} confidence</span>
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
    </main>
  );
}

// ── skeleton (mirrors the result card layout exactly) ────────────────────────

function SkeletonCard() {
  return (
    <div className="card">
      <div className="sk" style={{ height: 11, width: "22%" }} />
      <div className="sk" style={{ height: 18, width: "72%", marginTop: 8 }} />
      <div className="sk" style={{ height: 15, width: "42%", marginTop: 8 }} />
      <div className="sk" style={{ height: 14, width: "56%", marginTop: 12 }} />
      <div className="sk" style={{ height: 12, width: "90%", marginTop: 12 }} />
      <div className="sk" style={{ height: 12, width: "78%", marginTop: 6 }} />
      <div className="btn-row">
        <div className="sk" style={{ height: 44, flex: 1 }} />
        <div className="sk" style={{ height: 44, flex: 1 }} />
      </div>
    </div>
  );
}

// ── tap-to-edit text field ───────────────────────────────────────────────────

function InlineText({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        className="field-input"
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className={`field${className ? " " + className : ""}`}
      onClick={() => setEditing(true)}
    >
      {value || <span style={{ color: "var(--text-3)" }}>{placeholder}</span>}
    </button>
  );
}

// ── result card ──────────────────────────────────────────────────────────────

function CardView({
  card: c,
  onChange,
  onRetryScreenshot,
}: {
  card: Card;
  onChange: (patch: Partial<Card>) => void;
  onRetryScreenshot: () => void;
}) {
  const [dateOpen, setDateOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [added, setAdded] = useState(false);

  // unreadable → warm recovery card, screenshot as the primary action
  if (c.unreadable) {
    return (
      <div className="card card--recover rise">
        <div className="recover-title">Couldn’t read this one</div>
        <div className="recover-copy">A screenshot of the post usually works better.</div>
        <button
          className="btn btn-primary"
          style={{ marginTop: 12 }}
          onClick={onRetryScreenshot}
        >
          Try a screenshot
        </button>
      </div>
    );
  }

  // past → greyed, compressed, no actions
  if (c.past) {
    return (
      <div className="card card--past rise">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <div className="card-title">{c.title}</div>
          <span className="past-label">already happened</span>
        </div>
        {(c.timeStart || c.dateStart) && (
          <div className="card-date" style={{ color: "var(--text-3)" }}>
            {dateLine(c)}
          </div>
        )}
      </div>
    );
  }

  // "other" with nothing actionable → summary only
  if (c.type === "other" && !c.location && !c.dateStart && !c.timeStart) {
    return (
      <div className="card rise">
        <div className="card-title">{c.title}</div>
        {c.notes && <div className="card-notes">{c.notes}</div>}
      </div>
    );
  }

  const cal = toCalItem(c);
  const showCal = !(c.dateless && c.skip);

  return (
    <div className="card rise">
      <div className="card-kicker">{c.type}</div>

      {/* Title — the decision */}
      <div>
        <InlineText
          className="card-title"
          value={c.title}
          onChange={(t) => onChange({ title: t })}
          placeholder="Untitled"
        />
      </div>

      {/* Date/time — beneath the title, in accent */}
      {!c.dateless ? (
        <>
          <button
            type="button"
            className="card-date"
            onClick={() => setDateOpen((o) => !o)}
          >
            {dateLine(c)}{" "}
            <span style={{ opacity: 0.5, fontWeight: 400 }}>
              {dateOpen ? "▲" : "✎"}
            </span>
          </button>
          {dateOpen && <DateEdit c={c} onChange={onChange} />}
        </>
      ) : (
        <DatelessSuggest c={c} onChange={onChange} />
      )}

      {/* Location — third, with subtle via-Maps affordance */}
      {c.location && (
        <div className="card-loc">
          <span>📍</span>
          <InlineText
            value={c.location}
            onChange={(v) => onChange({ location: v })}
            placeholder="Add location"
          />
          {c.address_source === "resolved" && c.maps_url && (
            <a className="via-maps" href={c.maps_url} target="_blank" rel="noreferrer">
              via Maps
            </a>
          )}
        </div>
      )}

      {/* Notes — confirmation, collapsed to 2 lines */}
      {editingNotes ? (
        <textarea
          className="field-area"
          style={{ marginTop: 10 }}
          autoFocus
          value={c.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
          onBlur={() => setEditingNotes(false)}
        />
      ) : (
        c.notes && (
          <div>
            <div
              className={`card-notes${notesOpen ? "" : " clamp"}`}
              onClick={() => setEditingNotes(true)}
            >
              {c.notes}
            </div>
            {c.notes.length > 90 && (
              <button className="more" onClick={() => setNotesOpen((o) => !o)}>
                {notesOpen ? "less" : "more"}
              </button>
            )}
          </div>
        )
      )}

      {/* Actions */}
      {showCal ? (
        <>
          <div className="btn-row">
            <a
              className="btn btn-primary"
              href={icsHref(cal)}
              onClick={() => setAdded(true)}
            >
              Apple Calendar
            </a>
            <a
              className="btn btn-secondary"
              href={googleCalUrl(cal)}
              target="_blank"
              rel="noreferrer"
            >
              Google
            </a>
          </div>
          {added && <div className="added">✓ Added</div>}
        </>
      ) : (
        <div className="added" style={{ color: "var(--text-2)" }}>
          🔔 Reminder only — {c.reminderLabel}
        </div>
      )}
    </div>
  );
}

// Expandable date editor (revealed on tap — inputs are never always-visible).
function DateEdit({ c, onChange }: { c: Card; onChange: (p: Partial<Card>) => void }) {
  return (
    <div className="date-edit">
      <label className="allday-row">
        <input
          type="checkbox"
          checked={c.allDay}
          onChange={(e) => onChange({ allDay: e.target.checked })}
        />
        all-day
      </label>
      {c.allDay ? (
        <>
          <div className="col">
            <label>{c.isDateRange ? "Start day" : "Day"}</label>
            <input
              type="date"
              value={c.dateStart}
              onChange={(e) => onChange({ dateStart: e.target.value })}
            />
          </div>
          {c.isDateRange && (
            <div className="col">
              <label>End day</label>
              <input
                type="date"
                value={c.dateEnd}
                onChange={(e) => onChange({ dateEnd: e.target.value })}
              />
            </div>
          )}
        </>
      ) : (
        <>
          <div className="col">
            <label>Start</label>
            <input
              type="datetime-local"
              value={c.timeStart}
              onChange={(e) => onChange({ timeStart: e.target.value })}
            />
          </div>
          <div className="col">
            <label>End</label>
            <input
              type="datetime-local"
              value={c.timeEnd}
              onChange={(e) => onChange({ timeEnd: e.target.value })}
            />
          </div>
        </>
      )}
      <div className="col" style={{ flexBasis: "100%" }}>
        <label>Reminder</label>
        <input
          type="datetime-local"
          value={c.reminderLocal}
          onChange={(e) => onChange({ reminderLocal: e.target.value })}
        />
      </div>
    </div>
  );
}

// Dateless (place / recipe / product) — a suggestion, not a form.
function DatelessSuggest({
  c,
  onChange,
}: {
  c: Card;
  onChange: (p: Partial<Card>) => void;
}) {
  return (
    <div className="suggest">
      <div style={{ marginBottom: 6 }}>
        No date on this — {c.skip ? "just a reminder." : `try ${fmtDay(c.dateStart)}?`}
      </div>
      {!c.skip && (
        <input
          type="date"
          value={c.dateStart}
          onChange={(e) => onChange({ dateStart: e.target.value })}
          style={{
            height: 44,
            width: "100%",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "0 10px",
            fontSize: 16,
            color: "var(--text)",
          }}
        />
      )}
      <label className="allday-row" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          checked={c.skip}
          onChange={(e) => onChange({ skip: e.target.checked })}
        />
        just remind me, don’t add to calendar
      </label>
    </div>
  );
}

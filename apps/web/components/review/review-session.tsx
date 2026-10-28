"use client";
import { loadMedia } from "../../lib/coach-media/client";
import { verifyAndApprove } from "../../lib/review/client";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useSessionFlow } from "../sessions/session-context";
import { HearCoach } from "../player/hear-coach";
import { formatTime } from "../player/video-player";
import type { Playback, Mark } from "../../lib/overlay/draw";
import styles from "../sessions/sessions.module.css";
export function ReviewSession({
  simple = false,
  annotationId,
}: {
  simple?: boolean;
  annotationId?: string;
}) {
  const { userId, sessionId: loginId } = useAuth();
  const { detail } = useSessionFlow();
  const data = useQuery(api.playback.get, { sessionId: detail.id });
  return data && data.id === detail.id && data.ownerUserId === userId ? (
    <Review
      key={`${data.id}:${userId}:${loginId}`}
      data={data}
      simple={simple}
      annotationId={annotationId}
    />
  ) : (
    <p>Loading review…</p>
  );
}
function Review({
  data,
  simple,
  annotationId,
}: {
  data: Playback;
  simple: boolean;
  annotationId?: string;
}) {
  const [tab, setTab] = useState("Needs you");
  return (
    <main className={styles.screen}>
      <Link href={`/sessions/${data.id}/playback`}>Playback</Link>
      <h1>{annotationId ? "Move mark" : "Review marks"}</h1>
      {annotationId && !data.annotations.some((a) => a.id === annotationId) && (
        <p>Mark unavailable.</p>
      )}
      {data.busy ? (
        <p>Processing is in progress.</p>
      ) : (
        <Link href={`/sessions/${data.id}/subject`}>Change who to follow</Link>
      )}
      {data.subjectStatus === "anchor_failed" && (
        <p>
          Your selected player could not be found. Pick who to follow again.
        </p>
      )}
      {!simple && (
        <nav aria-label="Review tabs">
          {["Needs you", "Approved", "AI suggestions"].map((t) => (
            <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
              {t} (
              {t === "AI suggestions"
                ? data.suggestions.length
                : data.annotations.filter((a) =>
                    t === "Approved"
                      ? a.status === "approved"
                      : a.status !== "approved" && a.status !== "deleted",
                  ).length}
              )
            </button>
          ))}
        </nav>
      )}
      {tab === "AI suggestions" ? (
        <section>
          {data.suggestions.length ? (
            data.suggestions.map((s, i) => (
              <article
                key={s.id + i}
                style={{ border: "2px dashed #777", padding: 16 }}
              >
                <h2>{s.title}</h2>
                <p>Not something you said</p>
                <p>Why: {s.why}</p>
                {s.approved && <p>AI suggested · approved by coach</p>}
              </article>
            ))
          ) : (
            <p>No suggestions.</p>
          )}
        </section>
      ) : (
        data.remarks
          .filter(
            (r) =>
              !annotationId ||
              data.annotations.some(
                (a) => a.id === annotationId && a.remarkId === r.id,
              ),
          )
          .map((r) => (
            <section key={r.id}>
              <h2>COACH SAID · {formatTime(r.atMs)}</h2>
              <blockquote>{r.words}</blockquote>
              {r.turns.map(
                (t) =>
                  !simple && (
                    <TurnCorrection key={t.id} sessionId={data.id} turn={t} />
                  ),
              )}
              <HearCoach sessionId={data.id} remark={r} />
              {!data.annotations.some((a) => a.remarkId === r.id) && (
                <p>No placement is available for this remark.</p>
              )}
              <p>
                {data.role} · {r.mode.replaceAll("_", " ")} ·{" "}
                {r.status.replaceAll("_", " ")}
              </p>
              {data.annotations
                .filter(
                  (a) =>
                    a.remarkId === r.id &&
                    (!annotationId || a.id === annotationId) &&
                    (annotationId ||
                      simple ||
                      a.status === "deleted" ||
                      (tab === "Approved"
                        ? a.status === "approved"
                        : a.status !== "approved")),
                )
                .map((a) => (
                  <ReviewCard
                    key={a.id}
                    data={data}
                    remark={r}
                    mark={a}
                    moveOpen={!!annotationId}
                    simple={simple}
                  />
                ))}
            </section>
          ))
      )}
    </main>
  );
}
function TurnCorrection({
  sessionId,
  turn,
}: {
  sessionId: Playback["id"];
  turn: Playback["remarks"][number]["turns"][number];
}) {
  const correct = useMutation(api.review.correctTurn);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(turn.correctedText ?? turn.text);
  const [error, setError] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return (
    <>
      {turn.correctedText && (
        <p>
          {turn.correctedText} <strong>corrected by coach</strong>
        </p>
      )}
      <button onClick={() => setEditing((x) => !x)}>Fix transcription</button>
      {editing && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await correct({
                sessionId,
                turnId: turn.id,
                correctedText: text,
              });
              if (active.current) setEditing(false);
            } catch {
              if (active.current) setError(true);
            }
          }}
        >
          <label>
            Corrected words
            <textarea
              value={text}
              maxLength={10000}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <button>Save correction</button>
        </form>
      )}
      {error && <p role="alert">Couldn’t save the correction. Try again.</p>}
    </>
  );
}
function ReviewCard({
  data,
  remark,
  mark,
  moveOpen = false,
  simple = false,
}: {
  data: Playback;
  remark: Playback["remarks"][number];
  mark: Mark;
  moveOpen?: boolean;
  simple?: boolean;
}) {
  const edit = useMutation(api.review.edit),
    remove = useMutation(api.review.delete),
    undo = useMutation(api.review.undoDelete);
  const [editing, setEditing] = useState(moveOpen),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false);
  const [editorRevision, setEditorRevision] = useState({
    updatedAt: mark.updatedAt,
    revision: data.revision,
  });
  const active = useRef(true);
  const abort = useRef(new AbortController());
  useEffect(() => {
    active.current = true;
    abort.current = new AbortController();
    return () => {
      active.current = false;
      abort.current.abort();
    };
  }, []);
  const bound = data.tracks.find(
    (t) =>
      t.trackId === mark.trackId &&
      t.remarkId === remark.id &&
      t.role === data.role,
  );
  const available =
    remark.mode === "note_only" ||
    (data.subjectStatus === "anchored" &&
      !!bound &&
      remark.aboutSubject === "yes");
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(false);
    try {
      await fn();
      if (active.current) setEditing(false);
    } catch {
      if (active.current) setError(true);
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return (
    <article
      aria-busy={busy}
      style={{
        border: mark.placedBy === "ai" ? "2px dashed #777" : "2px solid #333",
        padding: 16,
        marginBlock: 12,
      }}
    >
      <h3>{mark.labelText}</h3>
      {busy && <p role="status">Working on this mark…</p>}
      <p>
        {mark.placedBy === "ai" ? "◇ AI placed" : "● Placed by you"} ·{" "}
        {mark.status.replaceAll("_", " ")}
      </p>
      <p>Why here: {mark.why}</p>
      <p>
        {formatTime(mark.startMs)}–{formatTime(mark.endMs)} · {mark.role}
      </p>
      {!available && mark.status !== "approved" && (
        <p>
          This placement is unavailable for approval. Keep this remark as a
          note, or change who to follow.
        </p>
      )}
      <div className={styles.actions}>
        {mark.status === "deleted" ? (
          <button
            disabled={busy || data.busy}
            onClick={() => void perform(() => undo({ annotationId: mark.id }))}
          >
            Undo delete
          </button>
        ) : (
          <>
            <button
              disabled={
                busy || data.busy || !available || mark.status === "approved"
              }
              onClick={() =>
                void perform(() =>
                  verifyAndApprove(
                    mark.id,
                    mark.updatedAt,
                    data.revision,
                    abort.current.signal,
                  ),
                )
              }
            >
              Approve
            </button>
            <button
              disabled={busy || data.busy}
              onClick={() => {
                setEditorRevision({
                  updatedAt: mark.updatedAt,
                  revision: data.revision,
                });
                setEditing((x) => !x);
              }}
            >
              {simple ? "Retime" : "Edit / Move"}
            </button>
            {!simple && (
              <Link href={`/sessions/${data.id}/review/${mark.id}/move`}>
                Move mark
              </Link>
            )}
            <button
              disabled={busy || data.busy}
              onClick={() =>
                void perform(() => remove({ annotationId: mark.id }))
              }
            >
              Delete
            </button>
          </>
        )}
      </div>
      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const mode = (f.get("mode") ?? remark.mode) as
              "tracked" | "still_frame" | "note_only";
            void perform(async () => {
              const saved = await edit({
                expectedUpdatedAt: editorRevision.updatedAt,
                expectedRevision: editorRevision.revision,
                annotationId: mark.id,
                markType: (f.get("markType") ??
                  mark.markType) as Mark["markType"],
                anchor: (f.get("anchor") ?? mark.anchor) as Mark["anchor"],
                arrowFrom:
                  (f.get("markType") ?? mark.markType) === "arrow"
                    ? ((f.get("arrowFrom") ??
                        mark.arrowFrom) as Mark["arrowFrom"])
                    : undefined,
                startMs: Number(f.get("startMs")),
                endMs: Number(f.get("endMs")),
                mode,
                labelSpan:
                  (f.get("labelChoice") ??
                    (mark.labelSpan ? "original" : mark.neutralLabel)) ===
                  "original"
                    ? (mark.originalLabelSpan ?? mark.labelSpan)
                    : undefined,
                neutralLabel:
                  (f.get("labelChoice") ??
                    (mark.labelSpan ? "original" : mark.neutralLabel)) ===
                  "original"
                    ? undefined
                    : ((f.get("labelChoice") ??
                        mark.neutralLabel) as Mark["neutralLabel"]),
              });
              if (!active.current) return;
              setEditorRevision(saved);
              await verifyAndApprove(
                mark.id,
                saved.updatedAt,
                saved.revision,
                abort.current.signal,
              );
            });
          }}
        >
          <fieldset disabled={busy || data.busy}>
            {!simple && (
              <>
                <label>
                  Label
                  <select
                    name="labelChoice"
                    defaultValue={
                      mark.labelSpan ? "original" : mark.neutralLabel
                    }
                  >
                    {(mark.originalLabelSpan ?? mark.labelSpan) && (
                      <option value="original">Coach’s original words</option>
                    )}
                    <option
                      value={
                        data.role === "batter"
                          ? "Batter"
                          : data.role === "bowler"
                            ? "Bowler"
                            : "Player"
                      }
                    >
                      {data.role === "batter"
                        ? "Batter"
                        : data.role === "bowler"
                          ? "Bowler"
                          : "Player"}
                    </option>
                    <option value="Remark">Remark</option>
                  </select>
                </label>
                <label>
                  Arrow direction
                  <select
                    name="arrowFrom"
                    defaultValue={mark.arrowFrom ?? "left"}
                  >
                    {["left", "right", "above", "below"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Placement
                  <select name="mode" defaultValue={remark.mode}>
                    <option
                      value="tracked"
                      disabled={!bound || bound.mode !== "video"}
                    >
                      Follow selected player
                    </option>
                    <option value="still_frame" disabled={!bound}>
                      Still frame
                    </option>
                    <option value="note_only">Note only</option>
                  </select>
                </label>
                <label>
                  Mark
                  <select name="markType" defaultValue={mark.markType}>
                    {["circle", "arrow", "highlight", "label"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Position
                  <select name="anchor" defaultValue={mark.anchor}>
                    {[
                      "box_center",
                      "box_top",
                      "box_bottom",
                      "box_left",
                      "box_right",
                    ].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <TimeControls
              mark={mark}
              remark={remark}
              sessionId={data.id}
              duration={data.durationMs}
              busy={busy}
            />
            <button disabled={busy || data.busy}>Save and approve</button>
          </fieldset>
        </form>
      )}
      {error && (
        <p role="alert">
          Couldn’t approve this revision. Refresh if it changed, adjust the
          range, keep it as a note, or pick who to follow again. Then retry.
        </p>
      )}
    </article>
  );
}

function TimeControls({
  mark,
  remark,
  duration,
  sessionId,
  busy,
}: {
  sessionId: string;
  mark: Mark;
  remark: Playback["remarks"][number];
  duration?: number;
  busy: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [source, setSource] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const element = video.current;
    void loadMedia(sessionId, "proxy", controller.signal)
      .then((media) => {
        if (!controller.signal.aborted) setSource(media.url);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUnavailable(true);
      });
    return () => {
      controller.abort();
      if (element) {
        element.pause();
        element.removeAttribute("src");
        element.load();
      }
    };
  }, [sessionId]);
  const min = Math.max(0, remark.momentStartMs ?? 0);
  const max = Math.min(duration ?? 0, remark.momentEndMs ?? duration ?? 0);
  const [start, setStart] = useState(mark.startMs);
  const [end, setEnd] = useState(mark.endMs);
  // The numeric fields remain available for precision. Keep both views in sync.
  function update(
    el: HTMLInputElement | HTMLButtonElement,
    a: number,
    b: number,
  ) {
    const form = el.form!;
    (form.elements.namedItem("startMs") as HTMLInputElement).value = String(a);
    (form.elements.namedItem("endMs") as HTMLInputElement).value = String(b);
    setStart(a);
    setEnd(b);
    if (video.current && source) video.current.currentTime = a / 1000;
  }
  return (
    <fieldset disabled={busy}>
      <legend>Retime within this moment</legend>
      <video
        ref={video}
        src={source}
        controls
        playsInline
        preload="metadata"
        aria-label="Unmarked retiming video"
        style={{ width: "100%" }}
        onLoadedMetadata={(e) => {
          e.currentTarget.currentTime = start / 1000;
        }}
        onSeeking={(e) => {
          const v = e.currentTarget;
          const bounded = Math.max(
            min / 1000,
            Math.min(v.currentTime, max / 1000),
          );
          if (bounded !== v.currentTime) v.currentTime = bounded;
        }}
        onTimeUpdate={(e) => {
          if (e.currentTarget.currentTime >= max / 1000)
            e.currentTarget.pause();
        }}
        onError={() => setUnavailable(true)}
      />
      {unavailable && (
        <p>Video unavailable. Adjust the time range or return to playback.</p>
      )}
      {mark.checkedRange && (
        <p>
          ◇ Original AI range: {formatTime(mark.checkedRange.startMs)}–
          {formatTime(mark.checkedRange.endMs)}
        </p>
      )}
      <p>
        ● Coach range: {formatTime(start)}–{formatTime(end)}
      </p>
      {[-500, 500].map((delta) => (
        <button
          type="button"
          key={delta}
          onClick={(e) => {
            const f = e.currentTarget.form!;
            const a = Number(
              (f.elements.namedItem("startMs") as HTMLInputElement).value,
            );
            const b = Number(
              (f.elements.namedItem("endMs") as HTMLInputElement).value,
            );
            const shift = Math.max(min - a, Math.min(delta, max - b));
            update(e.currentTarget, a + shift, b + shift);
          }}
        >
          {delta < 0 ? "−0.5 s" : "+0.5 s"}
        </button>
      ))}
      <label>
        Start (milliseconds)
        <input
          name="startMs"
          type="number"
          min={min}
          max={Math.max(min, end - 1)}
          step={1}
          value={start}
          onChange={(e) => update(e.currentTarget, Number(e.target.value), end)}
        />
      </label>
      <label>
        End (milliseconds)
        <input
          name="endMs"
          type="number"
          min={Math.min(max, start + 1)}
          max={max}
          step={1}
          value={end}
          onChange={(e) =>
            update(e.currentTarget, start, Number(e.target.value))
          }
        />
      </label>
      <label>
        Drag start
        <input
          aria-label="Drag start"
          type="range"
          min={min}
          max={Math.max(min, end - 1)}
          step={1}
          value={start}
          onChange={(e) => update(e.currentTarget, Number(e.target.value), end)}
        />
      </label>
      <label>
        Drag end
        <input
          aria-label="Drag end"
          type="range"
          min={Math.min(max, start + 1)}
          max={max}
          step={1}
          value={end}
          onChange={(e) =>
            update(e.currentTarget, start, Number(e.target.value))
          }
        />
      </label>
    </fieldset>
  );
}

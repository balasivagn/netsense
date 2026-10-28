"use client";
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
  const { userId } = useAuth();
  const { detail } = useSessionFlow();
  const data = useQuery(api.playback.get, { sessionId: detail.id });
  return data && data.id === detail.id && data.ownerUserId === userId ? (
    <Review
      key={data.id}
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
              {r.turns.map((t) => (
                <TurnCorrection key={t.id} sessionId={data.id} turn={t} />
              ))}
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
  const approve = useMutation(api.review.approve),
    edit = useMutation(api.review.edit),
    remove = useMutation(api.review.delete),
    undo = useMutation(api.review.undoDelete);
  const [editing, setEditing] = useState(moveOpen),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const bound = data.tracks.find(
    (t) =>
      t.trackId === mark.trackId &&
      t.remarkId === remark.id &&
      t.role === data.role,
  );
  const rangeChecked =
    !!mark.checkVerdict?.pass &&
    mark.startMs === mark.checkedRange?.startMs &&
    mark.endMs === mark.checkedRange?.endMs;
  const available =
    remark.mode === "note_only" ||
    (data.subjectStatus === "anchored" &&
      rangeChecked &&
      !!bound &&
      (mark.placedBy === "coach" || mark.checkVerdict?.pass === true));
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
      style={{
        border: mark.placedBy === "ai" ? "2px dashed #777" : "2px solid #333",
        padding: 16,
        marginBlock: 12,
      }}
    >
      <h3>{mark.labelText}</h3>
      <p>
        {mark.placedBy === "ai" ? "◇ AI placed" : "● Placed by you"} ·{" "}
        {mark.status.replaceAll("_", " ")}
      </p>
      <p>Why here: {mark.why}</p>
      <p>
        {formatTime(mark.startMs)}–{formatTime(mark.endMs)} · {mark.role}
      </p>
      {!available && (
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
                void perform(() => approve({ annotationId: mark.id }))
              }
            >
              Approve
            </button>
            <button
              disabled={busy || data.busy}
              onClick={() => setEditing((x) => !x)}
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
            void perform(() =>
              edit({
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
                    ? mark.labelSpan
                    : undefined,
                neutralLabel:
                  (f.get("labelChoice") ??
                    (mark.labelSpan ? "original" : mark.neutralLabel)) ===
                  "original"
                    ? undefined
                    : ((f.get("labelChoice") ??
                        mark.neutralLabel) as Mark["neutralLabel"]),
              }),
            );
          }}
        >
          {!simple && (
            <>
              <label>
                Label
                <select
                  name="labelChoice"
                  defaultValue={mark.labelSpan ? "original" : mark.neutralLabel}
                >
                  {mark.labelSpan && (
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
          <label>
            Start (milliseconds)
            <input
              name="startMs"
              type="number"
              step="1"
              min={remark.momentStartMs}
              max={remark.momentEndMs}
              defaultValue={mark.startMs}
            />
          </label>
          <label>
            End (milliseconds)
            <input
              name="endMs"
              type="number"
              step="1"
              min={remark.momentStartMs}
              max={remark.momentEndMs}
              defaultValue={mark.endMs}
            />
          </label>
          <button disabled={busy}>Save placement</button>
        </form>
      )}
      {error && (
        <p role="alert">
          Couldn’t save this change. Check the placement and try again.
        </p>
      )}
    </article>
  );
}

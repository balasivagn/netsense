"use client";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useSessionFlow } from "../sessions/session-context";
import { loadMedia } from "../../lib/coach-media/client";
import type { TrackFile } from "../../../../packages/contracts/gen/TrackFile";
import type { Playback } from "../../lib/overlay/draw";
import { OverlayCanvas } from "./overlay-canvas";
import { HearCoach } from "./hear-coach";
import styles from "../sessions/sessions.module.css";
export function PlaybackSession() {
  const { userId } = useAuth();
  const { detail } = useSessionFlow();
  const data = useQuery(api.playback.get, { sessionId: detail.id });
  return data && data.id === detail.id && data.ownerUserId === userId ? (
    <Player key={data.id + data.revision} data={data} />
  ) : (
    <p>Loading playback…</p>
  );
}
export function Player({ data }: { data: Playback }) {
  const video = useRef<HTMLVideoElement>(null);
  const attachVideo = useCallback((node: HTMLVideoElement | null) => {
    const old = video.current;
    if (old && old !== node) {
      old.pause();
      old.removeAttribute("src");
      old.load();
    }
    video.current = node;
  }, []);
  const [source, setSource] = useState<string>();
  const [baked, setBaked] = useState(false);
  const [tracks, setTracks] = useState<Record<string, TrackFile>>({});
  const [failed, setFailed] = useState(false);
  const [forceProxy, setForceProxy] = useState(false);
  const [unmarked, setUnmarked] = useState(false);
  const [ms, setMs] = useState(0);
  const [stills, setStills] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    const v = video.current;
    setSource(undefined);
    setBaked(false);
    setTracks({});
    setStills({});
    setFailed(false);
    void (async () => {
      try {
        let media;
        let isPreview = false;
        if (
          data.preview?.fileRef &&
          data.preview.mode === "video" &&
          !unmarked &&
          !forceProxy
        ) {
          try {
            media = await loadMedia(data.id, "preview", c.signal);
            isPreview = true;
          } catch {
            c.signal.throwIfAborted();
          }
        }
        if (!media) media = await loadMedia(data.id, "proxy", c.signal);
        if (c.signal.aborted) return;
        setSource(media.url);
        setBaked(isPreview);
      } catch {
        if (!c.signal.aborted) setFailed(true);
      }
    })();
    // Small sequential queue bounds signing/storage work and aborts on scope change.
    void (async () => {
      for (const t of data.tracks) {
        if (c.signal.aborted) return;
        try {
          const m = await loadMedia(data.id, `track:${t.remarkId}`, c.signal);
          if (!c.signal.aborted && m.track && m.trackId === t.trackId)
            setTracks((prev) => ({ ...prev, [t.trackId]: m.track! }));
        } catch {
          /* An unavailable track never draws an alternative person. */
        }
      }
    })();
    void (async () => {
      for (const s of data.preview?.stillRefs ?? []) {
        if (c.signal.aborted) return;
        try {
          const m = await loadMedia(
            data.id,
            `still:${s.annotationId}`,
            c.signal,
          );
          if (!c.signal.aborted && m.url)
            setStills((prev) => ({ ...prev, [s.annotationId]: m.url! }));
        } catch {
          /* Missing stills remain unavailable. */
        }
      }
    })();
    return () => {
      c.abort();
      v?.pause();
      v?.removeAttribute("src");
      v?.load();
    };
  }, [data, unmarked, forceProxy, attempt]);
  const active = data.remarks.find(
    (r) =>
      (r.momentStartMs ?? r.atMs) <= ms && ms < (r.momentEndMs ?? r.atMs + 1),
  );
  return (
    <main className={styles.screen}>
      <Link href="/sessions">Sessions</Link>
      <h1>Playback</h1>
      {data.isDemoFallback && (
        <p className={styles.fallback}>Recorded run (fallback)</p>
      )}
      {data.renderMode === "stills" && (
        <p className={styles.fallback}>Still frames only</p>
      )}
      {source ? (
        <div style={{ position: "relative", width: "100%" }}>
          <video
            ref={attachVideo}
            src={source}
            controls
            playsInline
            style={{ width: "100%", display: "block" }}
            onTimeUpdate={(e) => setMs(e.currentTarget.currentTime * 1000)}
            onError={() => {
              if (baked) {
                setForceProxy(true);
              } else setFailed(true);
            }}
          />
          {!baked && !unmarked && data.renderMode !== "stills" && (
            <OverlayCanvas video={video} data={data} tracks={tracks} />
          )}
        </div>
      ) : (
        <p>
          {failed
            ? "Video is unavailable. Please try again."
            : "Opening video…"}
        </p>
      )}
      {failed && (
        <button onClick={() => setAttempt((x) => x + 1)}>Try again</button>
      )}
      {data.renderMode === "stills" && (
        <>
          <button onClick={() => setUnmarked(true)}>
            Watch unmarked video
          </button>
          <div aria-label="Still frames">
            {!data.preview?.stillRefs.length && (
              <p>
                No marked still frames are available. You can watch the unmarked
                video.
              </p>
            )}
            {Object.entries(stills).map(([id, url]) => (
              <button
                key={id}
                onClick={() => {
                  const mark = data.annotations.find((a) => a.id === id);
                  const remark = data.remarks.find(
                    (r) => r.id === mark?.remarkId,
                  );
                  if (video.current && remark)
                    video.current.currentTime =
                      (remark.keyframeMs ?? remark.atMs) / 1000;
                }}
              >
                <img
                  src={url}
                  alt="Marked still frame"
                  style={{ maxWidth: "100%" }}
                />
              </button>
            ))}
          </div>
        </>
      )}
      <Link className={styles.primary} href={`/sessions/${data.id}/review`}>
        Review marks
      </Link>
      <ol aria-label="Remarks timeline">
        {data.remarks.map((r) => (
          <li
            style={{
              borderLeft: data.annotations.some(
                (a) => a.remarkId === r.id && a.placedBy === "coach",
              )
                ? "3px solid #333"
                : "3px dashed #777",
              paddingLeft: 8,
            }}
            key={r.id}
            aria-current={active?.id === r.id ? "true" : undefined}
          >
            <button
              onClick={() => {
                if (video.current)
                  video.current.currentTime =
                    (r.momentStartMs ?? r.atMs) / 1000;
                setMs(r.momentStartMs ?? r.atMs);
              }}
            >
              {formatTime(r.atMs)} · {r.words}
            </button>
            <HearCoach
              key={r.id + (active?.id ?? "")}
              sessionId={data.id}
              remark={r}
            />
          </li>
        ))}
      </ol>
    </main>
  );
}
export function formatTime(ms: number) {
  return `${Math.floor(ms / 60000)
    .toString()
    .padStart(2, "0")}:${Math.floor((ms / 1000) % 60)
    .toString()
    .padStart(2, "0")}`;
}

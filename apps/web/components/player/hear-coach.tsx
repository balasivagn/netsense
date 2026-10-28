"use client";
import { useEffect, useRef, useState } from "react";
import type { Playback } from "../../lib/overlay/draw";
import { loadMedia } from "../../lib/coach-media/client";
// One original-audio excerpt at a time, including across separate remark cards.
let stopCurrent: (() => void) | undefined;
export function HearCoach({
  sessionId,
  remark,
}: {
  sessionId: string;
  remark: Playback["remarks"][number];
}) {
  const request = useRef<AbortController | null>(null),
    stop = useRef<(() => void) | null>(null);
  const [error, setError] = useState(false);
  useEffect(
    () => () => {
      request.current?.abort();
      stop.current?.();
    },
    [sessionId, remark.id],
  );
  if (remark.source !== "voice" || !remark.turns.length) return null;
  return (
    <>
      <button
        onClick={async () => {
          stopCurrent?.();
          request.current?.abort();
          const c = new AbortController();
          request.current = c;
          setError(false);
          let audio: HTMLAudioElement | undefined,
            timer: ReturnType<typeof setTimeout> | undefined;
          const cleanup = () => {
            c.abort();
            clearTimeout(timer);
            if (audio) {
              audio.pause();
              audio.removeAttribute("src");
              audio.onloadedmetadata = null;
              audio.ontimeupdate = null;
              audio.onerror = null;
              audio.onplaying = null;
              audio.onwaiting = null;
              audio.onpause = null;
            }
            if (stopCurrent === cleanup) stopCurrent = undefined;
          };
          stop.current = cleanup;
          stopCurrent = cleanup;
          try {
            const media = await loadMedia(sessionId, "audio", c.signal);
            if (c.signal.aborted || !media.url) return;
            const a = new Audio(media.url);
            audio = a;
            let index = 0;
            const playTurn = () => {
              if (c.signal.aborted || index >= remark.turns.length) return;
              a.currentTime = remark.turns[index].startMs / 1000;
              void a.play().catch(() => {
                if (!c.signal.aborted) {
                  setError(true);
                  cleanup();
                }
              });
            };
            const advance = () => {
              clearTimeout(timer);
              a.pause();
              index++;
              if (index < remark.turns.length) playTurn();
              else cleanup();
            };
            a.ontimeupdate = () => {
              if (
                index < remark.turns.length &&
                a.currentTime * 1000 >= remark.turns[index].endMs
              )
                advance();
            };
            const armEndpoint = () => {
              clearTimeout(timer);
              if (c.signal.aborted || index >= remark.turns.length) return;
              timer = setTimeout(() => {
                // Wall-clock time can pass while the media clock is buffering.
                // Never skip unplayed original speech on a timer alone.
                if (a.currentTime * 1000 >= remark.turns[index].endMs) advance();
                else armEndpoint();
              }, Math.max(20, remark.turns[index].endMs - a.currentTime * 1000));
            };
            a.onplaying = armEndpoint;
            a.onwaiting = () => clearTimeout(timer);
            a.onpause = () => clearTimeout(timer);
            a.onloadedmetadata = playTurn;
            a.onerror = () => {
              if (!c.signal.aborted) {
                setError(true);
                cleanup();
              }
            };
          } catch {
            if (!c.signal.aborted) {
              setError(true);
              cleanup();
            }
          }
        }}
      >
        Hear coach
      </button>
      {error && (
        <p role="alert">Couldn’t play the original audio. Try again.</p>
      )}
    </>
  );
}

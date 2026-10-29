"use client";
import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { failureStore } from "../../lib/session-flow/failure-store";
import { SessionFlow } from "../../lib/session-flow/flow";
import { browserRecoveryStore } from "../../lib/upload/resume";
import { createUploadTransport } from "../../lib/upload/transport";
import styles from "./sessions.module.css";

type Detail = FunctionReturnType<typeof api.coachSessions.detail>;
const Context = createContext<{ flow: SessionFlow; detail: Detail } | null>(
  null,
);
function OwnedFlow({
  coachId,
  sessionId,
  detail,
  children,
}: {
  coachId: string;
  sessionId: Id<"sessions">;
  detail: Detail;
  children: ReactNode;
}) {
  const selectMode = useMutation(api.sessions.selectCaptureMode);
  const begin = useMutation(api.coachSessions.beginAttempt);
  const fail = useMutation(api.coachSessions.failAttempt);
  const [lifetime] = useState(() => ({
    mounted: false,
    flow: new SessionFlow({
      coachId,
      sessionId,
      failureStore: failureStore(coachId, sessionId),
      transport: createUploadTransport(),
      recovery: browserRecoveryStore(),
      selectMode: (captureMode) => selectMode({ sessionId, captureMode }),
      beginAttempt: () => begin({ sessionId }),
      failAttempt: (attempt) => fail({ sessionId, attempt }),
    }),
  }));
  useEffect(() => {
    lifetime.mounted = true;
    return () => {
      lifetime.mounted = false;
      queueMicrotask(() => {
        if (!lifetime.mounted) lifetime.flow.dispose();
      });
    };
  }, [lifetime]);
  return (
    <Context.Provider value={{ flow: lifetime.flow, detail }}>
      {children}
    </Context.Provider>
  );
}
export function SessionProvider({
  sessionId,
  children,
}: {
  sessionId: Id<"sessions">;
  children: ReactNode;
}) {
  const { userId, sessionId: loginId } = useAuth();
  const detail = useQuery(
    api.coachSessions.detail,
    userId ? { sessionId } : "skip",
  );
  if (!userId || !detail)
    return <main className={styles.screen}>Loading session…</main>;
  return (
    <OwnedFlow
      key={JSON.stringify([userId, loginId, sessionId])}
      coachId={userId}
      sessionId={sessionId}
      detail={detail}
    >
      {children}
    </OwnedFlow>
  );
}
export function useSessionFlow() {
  const value = useContext(Context);
  if (!value) throw Error("SESSION_CONTEXT_REQUIRED");
  const state = useSyncExternalStore(
    value.flow.subscribe,
    value.flow.snapshot,
    value.flow.snapshot,
  );
  return { ...value, state };
}

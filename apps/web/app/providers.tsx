"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexReactClient, useConvexAuth, useMutation } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "../../../convex/_generated/api";

type CoachProvisioningState = "loading" | "ready" | "unavailable";

export function coachProvisioningPlan({
  clerkLoaded,
  convexLoading,
  clerkUserId,
  convexAuthenticated,
}: {
  clerkLoaded: boolean;
  convexLoading: boolean;
  clerkUserId: string | null;
  convexAuthenticated: boolean;
}): "wait" | "provision" | "unavailable" {
  if (!clerkLoaded || convexLoading) return "wait";
  return clerkUserId && convexAuthenticated ? "provision" : "unavailable";
}

const CoachProvisioningContext =
  createContext<CoachProvisioningState>("loading");

function CoachBootstrap({ children }: { children: ReactNode }) {
  const { isLoaded, userId } = useAuth();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const ensureCoach = useMutation(api.coaches.ensure);
  const [state, setState] = useState<CoachProvisioningState>("loading");
  const currentPlan = coachProvisioningPlan({
    clerkLoaded: isLoaded,
    convexLoading: isLoading,
    clerkUserId: userId ?? null,
    convexAuthenticated: isAuthenticated,
  });

  useEffect(() => {
    let active = true;

    const plan = coachProvisioningPlan({
      clerkLoaded: isLoaded,
      convexLoading: isLoading,
      clerkUserId: userId ?? null,
      convexAuthenticated: isAuthenticated,
    });

    if (plan === "wait") {
      setState("loading");
      return () => {
        active = false;
      };
    }

    if (plan === "unavailable") {
      setState("unavailable");
      return () => {
        active = false;
      };
    }

    setState("loading");
    void ensureCoach().then(
      () => {
        if (active) setState("ready");
      },
      () => {
        // A failed identity bootstrap is fail-closed. Do not retry or expose
        // backend details; a session/account change starts a fresh attempt.
        if (active) setState("unavailable");
      },
    );

    return () => {
      active = false;
    };
  }, [ensureCoach, isAuthenticated, isLoaded, isLoading, userId]);

  return (
    <CoachProvisioningContext.Provider value={currentPlan === "provision" ? state : currentPlan === "wait" ? "loading" : "unavailable"}>
      {children}
    </CoachProvisioningContext.Provider>
  );
}

function SessionProviders({ children }: { children: ReactNode }) {
  const convex = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) throw new Error("Missing NEXT_PUBLIC_CONVEX_URL");
    return { client: new ConvexReactClient(url), mounted: false, closed: false };
  }, []);

  useEffect(() => {
    convex.mounted = true;
    return () => {
      convex.mounted = false;
      // Strict Mode replays setup/cleanup. Close only after a real unmount,
      // so replay cannot close the live client's connection.
      queueMicrotask(() => {
        if (!convex.mounted && !convex.closed) {
          convex.closed = true;
          void convex.client.close();
        }
      });
    };
  }, [convex]);

  return (
    <ConvexProviderWithClerk client={convex.client} useAuth={useAuth}>
      <CoachBootstrap>{children}</CoachBootstrap>
    </ConvexProviderWithClerk>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  const { userId, sessionId } = useAuth();
  // A fresh provider starts unauthenticated. Old mutation completions, query
  // cache and auth confirmations cannot carry across an account/session switch.
  const identity = JSON.stringify([userId ?? null, sessionId ?? null]);
  return <SessionProviders key={identity}>{children}</SessionProviders>;
}

export function CoachProvisioningGate({ children }: { children: ReactNode }) {
  const state = useContext(CoachProvisioningContext);

  if (state === "ready") return <>{children}</>;
  if (state === "unavailable") {
    return (
      <main className="auth-state" role="alert">
        We couldn’t verify this coach account. Please sign in again.
      </main>
    );
  }
  return (
    <main className="auth-state" aria-live="polite">
      Preparing your coach account…
    </main>
  );
}

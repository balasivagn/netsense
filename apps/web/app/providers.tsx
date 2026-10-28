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
    <CoachProvisioningContext.Provider value={state}>
      {children}
    </CoachProvisioningContext.Provider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  const convex = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) throw new Error("Missing NEXT_PUBLIC_CONVEX_URL");
    return new ConvexReactClient(url);
  }, []);

  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      <CoachBootstrap>{children}</CoachBootstrap>
    </ConvexProviderWithClerk>
  );
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

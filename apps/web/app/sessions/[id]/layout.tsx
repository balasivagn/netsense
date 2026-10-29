"use client";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { SessionProvider } from "../../../components/sessions/session-context";
export default function SessionLayout({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  return (
    <SessionProvider key={id} sessionId={id as Id<"sessions">}>
      {children}
    </SessionProvider>
  );
}

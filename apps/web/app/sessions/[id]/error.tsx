"use client";
import Link from "next/link";
export default function SessionError() {
  return (
    <main className="auth-state" role="alert">
      <h1>Session unavailable</h1>
      <p>We couldn’t open this session.</p>
      <Link href="/sessions">Back to Sessions</Link>
    </main>
  );
}

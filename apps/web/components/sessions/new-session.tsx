"use client";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import styles from "./sessions.module.css";
// Screen 04: capture mode is chosen on Screen 06, never fabricated here.
export function NewSession() {
  const students = useQuery(api.students.list, {});
  const add = useMutation(api.students.add);
  const create = useMutation(api.sessions.create);
  const router = useRouter();
  const [studentId, setStudent] = useState("");
  const [role, setRole] = useState<"batter" | "bowler" | "other" | "">("");
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const locked = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function submit(kind: "add" | "create") {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      if (kind === "add") {
        const id = await add({ label });
        if (active.current) {
          setStudent(id);
          setAdding(false);
          setLabel("");
        }
      } else if (studentId && role) {
        const id = await create({
          studentId: studentId as Id<"students">,
          subjectRole: role,
        });
        if (active.current) router.push(`/sessions/${id}/record`);
      }
    } catch {
      if (active.current) setError("Couldn’t save. Please try again.");
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <main className={styles.screen}>
      <Link href="/sessions">Back to Sessions</Link>
      <h1>New session</h1>
      <label>
        Who is this lesson for?
        <select
          value={studentId}
          disabled={busy}
          onChange={(e) => setStudent(e.target.value)}
        >
          <option value="">Choose a student</option>
          {students?.map((s) => (
            <option key={s._id} value={s._id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <button disabled={busy} onClick={() => setAdding(!adding)}>
        + Add a student
      </button>
      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit("add");
          }}
        >
          <label>
            Student label
            <input
              maxLength={120}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <button disabled={busy || !label.trim()}>Save student</button>
        </form>
      )}
      <label>
        What are they doing?
        <select
          disabled={busy}
          value={role}
          onChange={(e) => setRole(e.target.value as typeof role)}
        >
          <option value="">Choose a role</option>
          <option value="batter">Batting</option>
          <option value="bowler">Bowling</option>
          <option value="other">Other</option>
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      <button
        className={styles.primary}
        disabled={busy || !studentId || !role}
        onClick={() => void submit("create")}
      >
        Continue
      </button>
    </main>
  );
}

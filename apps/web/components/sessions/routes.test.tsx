// @vitest-environment jsdom
// Component composition with real Convex transactions, controlled media/network seams; NOT browser E2E.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { File as NodeFile } from "node:buffer";
import { afterEach, expect, test, vi } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { UploadTransport } from "../../lib/upload/multipart";
import type { FunctionReturnType } from "convex/server";
import { api, internal } from "../../../../convex/_generated/api";
import { setup, data } from "../../../../convex/tests/helpers";
const state = vi.hoisted(() => ({
  userId: "",
  loginId: "",
  id: "",
  push: vi.fn(),
  replace: vi.fn(),
  detail: undefined as unknown,
  students: undefined as unknown,
  list: undefined as unknown,
  mutations: new Map<string, (args: never) => Promise<unknown>>(),
  transport: undefined as unknown,
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ userId: state.userId, sessionId: state.loginId }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push, replace: state.replace }),
  useParams: () => ({ id: state.id }),
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">, args: unknown) =>
    args === "skip"
      ? undefined
      : getFunctionName(ref) === "coachSessions:detail"
        ? state.detail
        : getFunctionName(ref) === "students:list"
          ? state.students
          : state.list,
  useMutation: (ref: FunctionReference<"mutation">) =>
    state.mutations.get(getFunctionName(ref)),
}));
vi.mock("../../lib/upload/transport", () => ({
  createUploadTransport: () => state.transport,
}));
vi.mock("../../lib/video/grab-frame", () => ({ grabFrame: vi.fn() }));
import { grabFrame } from "../../lib/video/grab-frame";
import SessionLayout from "../../app/sessions/[id]/layout";
import RecordPage from "../../app/sessions/[id]/record/page";
import UploadPage from "../../app/sessions/[id]/upload/page";
import SubjectPage from "../../app/sessions/[id]/subject/page";
import StatusPage from "../../app/sessions/[id]/status/page";
import NewPage from "../../app/sessions/new/page";
import ListPage from "../../app/sessions/page";

afterEach(() => {
  cleanup();
  state.mutations.clear();
  localStorage.clear();
  vi.clearAllMocks();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function harness(captureMode: "camera" | "camera_roll" = "camera_roll") {
  const h = await setup(false);
  await h.t.run((ctx) => ctx.db.delete(h.uploadId));
  state.id = h.sessionId;
  state.userId = data.identity.subject;
  state.loginId = data.identity.subject;
  for (const ref of [
    api.sessions.confirmConsent,
    api.sessions.selectCaptureMode,
    api.sessions.setSubject,
    api.coachSessions.beginAttempt,
    api.coachSessions.failAttempt,
    api.sessions.create,
    api.students.add,
  ]) {
    state.mutations.set(getFunctionName(ref), (args) =>
      h.coach.mutation(ref, args),
    );
  }
  const sync = async () => {
    state.detail = await h.coach.query(api.coachSessions.detail, {
      sessionId: h.sessionId,
    });
    state.students = await h.coach.query(api.students.list, {});
    state.list = await h.coach.query(api.coachSessions.list, {});
  };
  const gate = deferred();
  const transport: UploadTransport = {
    initialize: vi.fn(async (input) => {
      const session = await h.coach.query(api.sessions.get, {
        sessionId: h.sessionId,
      });
      expect(session.consentConfirmedAt).toBeTypeOf("number");
      expect(session.captureMode).toBe(captureMode);
      const u = await h.t.mutation(internal.uploads.reserve, {
        sha256: input.sha256,
        mimeType: input.mimeType,
        bytesTotal: input.bytesTotal,
        coachId: h.coachId,
        sessionId: h.sessionId,
        multipartUploadId: "00000000-0000-4000-8000-000000000000",
      });
      return {
        uploadId: u._id,
        partSize: u.partSize,
        partCount: 1,
        resumeFrom: u.partsConfirmed,
      };
    }),
    signParts: async () => [
      {
        partNumber: 1,
        url: "https://storage.invalid/part",
        expiresAt: Date.now() + 60000,
      },
    ],
    put: vi.fn(async () => {
      await gate.promise;
      return { bytes: data.upload.bytesTotal, etag: data.upload.sha256 };
    }),
    confirm: async (uploadId, input) =>
      h.t.mutation(internal.uploads.confirm, {
        uploadId: uploadId as typeof h.uploadId,
        coachId: h.coachId,
        ...input,
      }),
    complete: async (uploadId) => {
      await h.t.mutation(internal.uploads.begin, {
        uploadId: uploadId as typeof h.uploadId,
        coachId: h.coachId,
        operation: "completing",
      });
      return {
        jobId: await h.t.mutation(internal.uploads.complete, {
          uploadId: uploadId as typeof h.uploadId,
          coachId: h.coachId,
          verifiedBytes: data.upload.bytesTotal,
        }),
      };
    },
    abort: vi.fn(async () => {}),
  };
  state.transport = transport;
  vi.mocked(grabFrame).mockResolvedValue({
    url: "data:image/jpeg;base64,synthetic",
    frameMs: 0,
    durationMs: data.subject.frameMs,
    width: 400,
    height: 200,
  });
  await sync();
  const file = new NodeFile(
    [new Uint8Array(data.upload.bytesTotal)],
    "synthetic",
    { type: data.upload.mimeType },
  ) as unknown as File;
  return { ...h, file, sync, gate, transport };
}
async function pickFile(file: File, picker = "Pick clip") {
  const checkbox = screen.getByRole("checkbox");
  expect(
    (screen.getByRole("button", { name: "Pick clip" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Pick clip" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.change(screen.getByLabelText(picker, { selector: "input" }), {
    target: { files: [file] },
  });
}
async function tapPlayer() {
  const target = await screen.findByRole("button", {
    name: "Tap the player to follow",
  });
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: 400,
    height: 200,
    right: 400,
    bottom: 200,
    toJSON: () => ({}),
  });
  fireEvent.keyDown(target, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
}
for (const tapFirst of [true, false])
  test(`real route composition persists consent, retains source across navigation, enqueues once, tapFirst=${tapFirst}`, async () => {
    const h = await harness();
    const view = render(
      <SessionLayout>
        <RecordPage />
      </SessionLayout>,
    );
    await pickFile(h.file);
    await waitFor(() =>
      expect(state.push).toHaveBeenCalledWith(
        `/sessions/${h.sessionId}/subject`,
      ),
    );
    await waitFor(() => expect(h.transport.put).toHaveBeenCalled());
    if (!tapFirst) {
      h.gate.resolve();
      await waitFor(async () =>
        expect(
          (
            await h.coach.query(api.coachSessions.detail, {
              sessionId: h.sessionId,
            })
          ).upload?.complete,
        ).toBe(true),
      );
      await h.sync();
    }
    view.rerender(
      <SessionLayout>
        <UploadPage />
      </SessionLayout>,
    );
    expect(screen.queryByText(/Choose the clip again to resume/)).toBeNull();
    view.rerender(
      <SessionLayout>
        <SubjectPage />
      </SessionLayout>,
    );
    await tapPlayer();
    await waitFor(() =>
      expect(state.push).toHaveBeenCalledWith(
        `/sessions/${h.sessionId}/${tapFirst ? "upload" : "status"}`,
      ),
    );
    h.gate.resolve();
    await waitFor(async () =>
      expect(
        (
          await h.coach.query(api.coachSessions.detail, {
            sessionId: h.sessionId,
          })
        ).job?.status,
      ).toBe("queued"),
    );
    await h.sync();
    view.rerender(
      <SessionLayout>
        <StatusPage />
      </SessionLayout>,
    );
    expect(screen.getByText("Only you can see this draft.")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(
      (state.detail as FunctionReturnType<typeof api.coachSessions.detail>).job!
        .coachStages.length,
    );
    const jobId = (
      state.detail as FunctionReturnType<typeof api.coachSessions.detail>
    ).job!.id;
    await h.t.run((ctx) =>
      ctx.db.patch(jobId, {
        status: "running",
        coachStage: "Prepare preview",
        progressLabel: "Prepare preview",
        progress: 0.5,
      }),
    );
    await h.sync();
    view.rerender(
      <SessionLayout>
        <StatusPage />
      </SessionLayout>,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Your draft is being prepared.",
    );
    expect((screen.getByRole("progressbar") as HTMLProgressElement).value).toBe(
      0.5,
    );
    expect(await h.t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(
      1,
    );
  });

test("new session chooses student and role without an invented capture mode; list uses real label", async () => {
  const h = await harness();
  const view = render(<NewPage />);
  fireEvent.change(screen.getByLabelText("Who is this lesson for?"), {
    target: { value: h.studentId },
  });
  fireEvent.change(screen.getByLabelText("What are they doing?"), {
    target: { value: "batter" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(state.push).toHaveBeenCalled());
  const rows = await h.coach.query(api.sessions.list, {});
  expect(rows).toHaveLength(2);
  expect(rows[0].captureMode).toBeUndefined();
  await h.sync();
  view.rerender(<ListPage />);
  expect(screen.getAllByText(data.studentLabel)).toHaveLength(2);
});

test("cancel asks first, phone fallback stays pending, reload requires source reselect", async () => {
  const h = await harness();
  const view = render(
    <SessionLayout>
      <RecordPage />
    </SessionLayout>,
  );
  await pickFile(h.file);
  await waitFor(() => expect(h.transport.put).toHaveBeenCalled());
  vi.mocked(grabFrame).mockRejectedValue(Error("decode"));
  view.rerender(
    <SessionLayout>
      <SubjectPage />
    </SessionLayout>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Pick after upload" }),
  );
  expect(screen.getByText(/Processing waits for your tap/)).toBeTruthy();
  expect(await h.t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(
    0,
  );
  view.rerender(
    <SessionLayout>
      <UploadPage />
    </SessionLayout>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
  expect(h.transport.abort).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep uploading" }));
  expect(h.transport.abort).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
  fireEvent.click(screen.getByRole("button", { name: "Yes, cancel upload" }));
  await waitFor(() => expect(h.transport.abort).toHaveBeenCalledOnce());
  view.unmount();
  render(
    <SessionLayout>
      <UploadPage />
    </SessionLayout>,
  );
  expect(screen.getByText(/Choose the clip again to resume/)).toBeTruthy();
  h.gate.resolve();
});

test("exact CONSENT_REQUIRED from attempt admission resets Screen06 checkbox", async () => {
  const h = await harness();
  state.mutations.set(
    getFunctionName(api.coachSessions.beginAttempt),
    async () => {
      throw Error("CONSENT_REQUIRED");
    },
  );
  render(
    <SessionLayout>
      <RecordPage />
    </SessionLayout>,
  );
  await pickFile(h.file);
  await waitFor(() =>
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
      false,
    ),
  );
  expect(screen.getByText("Please confirm before uploading.")).toBeTruthy();
  expect(h.transport.initialize).not.toHaveBeenCalled();
});

test("late mode mutation after navigation away never navigates or uploads", async () => {
  const h = await harness();
  const pending = deferred();
  const original = state.mutations.get(
    getFunctionName(api.sessions.selectCaptureMode),
  )!;
  state.mutations.set(
    getFunctionName(api.sessions.selectCaptureMode),
    async (args) => {
      await pending.promise;
      return original(args);
    },
  );
  const view = render(
    <SessionLayout>
      <RecordPage />
    </SessionLayout>,
  );
  await pickFile(h.file);
  view.unmount();
  await act(async () => {
    pending.resolve();
    await pending.promise;
  });
  expect(state.push).not.toHaveBeenCalled();
  expect(h.transport.initialize).not.toHaveBeenCalled();
});

test("coach/login scope change clears source and consent and aborts old controller", async () => {
  const h = await harness();
  const view = render(
    <SessionLayout>
      <RecordPage />
    </SessionLayout>,
  );
  await pickFile(h.file);
  await waitFor(() => expect(h.transport.put).toHaveBeenCalled());
  state.loginId = data.otherIdentity.subject;
  view.rerender(
    <SessionLayout>
      <UploadPage />
    </SessionLayout>,
  );
  expect(screen.getByText(/Choose the clip again to resume/)).toBeTruthy();
  view.rerender(
    <SessionLayout>
      <RecordPage />
    </SessionLayout>,
  );
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
    false,
  );
  await act(async () => {
    h.gate.resolve();
    await h.gate.promise;
  });
  expect(
    (await h.coach.query(api.coachSessions.detail, { sessionId: h.sessionId }))
      .upload?.bytesConfirmed,
  ).toBe(0);
});


test("camera upload resumes from camera-roll reselect after reload without changing origin", async () => {
  const h = await harness("camera");
  const view = render(<SessionLayout><RecordPage /></SessionLayout>);
  await pickFile(h.file, "Open camera");
  await waitFor(() => expect(h.transport.put).toHaveBeenCalledOnce());
  await h.sync();
  view.unmount();
  await act(async () => { await Promise.resolve(); });
  state.push.mockClear();
  render(<SessionLayout><RecordPage /></SessionLayout>);
  await pickFile(h.file);
  await waitFor(() => expect(h.transport.initialize).toHaveBeenCalledTimes(2));
  expect((await h.coach.query(api.sessions.get, { sessionId: h.sessionId })).captureMode).toBe("camera");
  await act(async () => { h.gate.resolve(); await h.gate.promise; });
  await waitFor(async () => expect((await h.coach.query(api.coachSessions.detail, { sessionId: h.sessionId })).upload?.complete).toBe(true));
});

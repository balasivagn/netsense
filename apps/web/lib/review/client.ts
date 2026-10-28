export async function verifyAndApprove(
  annotationId: string,
  expectedUpdatedAt: number,
  expectedRevision: string,
  signal?: AbortSignal,
) {
  const response = await fetch("/api/review/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ annotationId, expectedUpdatedAt, expectedRevision }),
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(12000),
    ]),
    redirect: "error",
  });
  await response.body?.cancel();
  if (!response.ok) throw Error("REVIEW_RECHECK_REQUIRED");
}

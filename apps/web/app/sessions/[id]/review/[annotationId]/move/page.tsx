import { ReviewSession } from "../../../../../../components/review/review-session";
export default async function MovePage({
  params,
}: {
  params: Promise<{ annotationId: string }>;
}) {
  const { annotationId } = await params;
  return (
    <ReviewSession
      annotationId={annotationId}
      simple={process.env.FEATURE_REVIEW_MODE === "simple"}
    />
  );
}

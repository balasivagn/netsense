import { ReviewSession } from "../../../../components/review/review-session";
export default function ReviewPage() {
  return (
    <ReviewSession simple={process.env.FEATURE_REVIEW_MODE === "simple"} />
  );
}

import { Alert, AlertDescription } from "./ui/alert";

export function PageFeedback({
  message,
  error,
}: {
  message?: string | null;
  error: string | null;
}) {
  return (
    <>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {!error && message ? (
        <Alert role="status" aria-live="polite" className="border-success/50">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

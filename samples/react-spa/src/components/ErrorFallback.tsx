export default function ErrorFallback({ error }: { error: unknown }): JSX.Element {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="error-fallback" data-testid="error-fallback">
      <h2>Something broke</h2>
      <p>{message}</p>
      <p>This was reported to Bugsee via BugseeErrorBoundary.</p>
      <a href="/boards">Back to boards</a>
    </div>
  );
}

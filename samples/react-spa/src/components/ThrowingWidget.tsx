import { withBugseeErrorBoundary } from '@bugsee/react';

interface Props {
  armed: boolean;
  label: string;
}

/** Throws DURING RENDER when armed — the shape `BugseeErrorBoundary`/`getDerivedStateFromError` needs to
 *  catch (an event-handler throw does NOT reach a boundary; a render throw does). */
function ThrowingWidgetImpl({ armed, label }: Props): JSX.Element {
  if (armed) {
    throw new Error(`ThrowingWidget(${label}): deliberate render-phase throw for BugseeErrorBoundary`);
  }
  return <p data-testid={`widget-ok-${label}`}>{label}: rendering fine.</p>;
}

export default ThrowingWidgetImpl;

/** The HOC form under test — its OWN local boundary + fallback, isolated from the app-level one. */
export const GuardedThrowingWidget = withBugseeErrorBoundary(ThrowingWidgetImpl, {
  fallback: (error) => (
    <p className="status-line err" data-testid="guarded-widget-fallback">
      Guarded widget caught: {error instanceof Error ? error.message : String(error)}
    </p>
  ),
  mechanism: 'uncaught',
});

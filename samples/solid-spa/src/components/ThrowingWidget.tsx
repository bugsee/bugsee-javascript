import { ErrorBoundary, Show } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { solidErrorHandler } from '@bugsee/solid';

interface Props {
  armed: Accessor<boolean>;
  label: string;
}

/**
 * Throws from a reactive computation when armed — the shape Solid's `<ErrorBoundary>` needs to catch
 * (Solid components run their body ONCE at creation; a throw has to happen inside a computation that
 * re-runs when `armed` flips, which is exactly what a dynamic JSX expression compiles to).
 */
function ThrowingWidgetImpl(props: Props): JSX.Element {
  return (
    <Show
      when={props.armed()}
      fallback={<p data-testid={`widget-ok-${props.label}`}>{props.label}: rendering fine.</p>}
    >
      {(() => {
        throw new Error(`ThrowingWidget(${props.label}): deliberate render-phase throw for ErrorBoundary`);
      })()}
    </Show>
  );
}

export default ThrowingWidgetImpl;

/** The locally-guarded form under test — its OWN `<ErrorBoundary>` + `solidErrorHandler` fallback,
 *  isolated from the app-level one. */
export function GuardedThrowingWidget(props: Props): JSX.Element {
  return (
    <ErrorBoundary
      fallback={(error) => {
        solidErrorHandler({ mechanism: 'uncaught' })(error);
        return (
          <p class="status-line err" data-testid="guarded-widget-fallback">
            Guarded widget caught: {error instanceof Error ? error.message : String(error)}
          </p>
        );
      }}
    >
      <ThrowingWidgetImpl armed={props.armed} label={props.label} />
    </ErrorBoundary>
  );
}

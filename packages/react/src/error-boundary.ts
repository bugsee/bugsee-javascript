import type { Bugsee } from '@bugsee/browser';
import {
  Component,
  type ComponentType,
  createElement,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { type ReactErrorMechanism, reportReactError } from './report';

// The @bugsee/react ERROR SEAM (frontend-adapters D8). `BugseeErrorBoundary` is a class component (only
// class components can be React error boundaries): it catches a render error in its subtree, reports it
// via `reportReactError` (component stack linked through `error.cause`), and renders a fallback. The
// `withBugseeErrorBoundary` HOC wraps any component. React itself is only imported HERE (the structural-peer
// boundary); the reporting core (`./report`) stays React-free + injection-tested.

export interface BugseeErrorBoundaryProps {
  children?: ReactNode;
  /** Rendered when a descendant throws: a node, or `(error) => node`. Default: render nothing (`null`). */
  fallback?: ReactNode | ((error: unknown) => ReactNode);
  /** Resolve the client (default: the process-singleton carrier client). Injectable for tests. */
  getClient?: () => Bugsee | undefined;
  /** Called AFTER the error is reported (e.g. app-level logging / a toast). */
  onError?: (error: unknown, componentStack: string | undefined) => void;
  /** Capture mechanism (default `uncaught`). */
  mechanism?: ReactErrorMechanism;
}

interface BugseeErrorBoundaryState {
  hasError: boolean;
  error: unknown;
}

export class BugseeErrorBoundary extends Component<
  BugseeErrorBoundaryProps,
  BugseeErrorBoundaryState
> {
  override state: BugseeErrorBoundaryState = { hasError: false, error: undefined };

  /** React applies the returned object as the next state — flip to the error view. */
  static getDerivedStateFromError(error: unknown): BugseeErrorBoundaryState {
    return { hasError: true, error };
  }

  /** React's error side-channel: report it (with the component stack), then run the app's `onError`. */
  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const componentStack = errorInfo.componentStack ?? undefined;
    reportReactError(error, {
      ...(componentStack !== undefined ? { componentStack } : {}),
      ...(this.props.getClient !== undefined ? { getClient: this.props.getClient } : {}),
      ...(this.props.mechanism !== undefined ? { mechanism: this.props.mechanism } : {}),
    });
    this.props.onError?.(error, componentStack);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      const { fallback } = this.props;
      return typeof fallback === 'function' ? fallback(this.state.error) : (fallback ?? null);
    }
    return this.props.children ?? null;
  }
}

/** Wrap a component so a render error in its subtree is caught + reported (the HOC form of the boundary). */
export function withBugseeErrorBoundary<P extends object>(
  Wrapped: ComponentType<P>,
  boundaryProps?: Omit<BugseeErrorBoundaryProps, 'children'>,
): ComponentType<P> {
  const Boundary = (props: P): ReactNode =>
    createElement(BugseeErrorBoundary, boundaryProps, createElement(Wrapped, props));
  // `||` not `??`: an anonymous component has an empty-string `name`, which is not nullish.
  Boundary.displayName = `withBugseeErrorBoundary(${Wrapped.displayName || Wrapped.name || 'Component'})`;
  return Boundary;
}

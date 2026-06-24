import type { Bugsee } from '@bugsee/browser';
import type { ComponentType, ErrorInfo, ReactElement, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  BugseeErrorBoundary,
  type BugseeErrorBoundaryProps,
  withBugseeErrorBoundary,
} from './error-boundary';

function fakeClient() {
  const logException = vi.fn(
    (_error: unknown, _options?: { mechanism?: string }): Promise<{ ok: true }> =>
      Promise.resolve({ ok: true }),
  );
  return { client: { logException } as unknown as Bugsee, logException };
}

// Build a boundary instance without a renderer (injection-first): construct it, then drive its lifecycle
// methods directly. React applies `getDerivedStateFromError`'s return as the next state, so we mirror that.
function makeBoundary(props: Partial<BugseeErrorBoundaryProps> = {}) {
  const full: BugseeErrorBoundaryProps = { children: 'CHILDREN', ...props };
  return new BugseeErrorBoundary(full);
}

const errorInfo = (componentStack: string | null): ErrorInfo => ({ componentStack }) as ErrorInfo;

describe('BugseeErrorBoundary', () => {
  it('renders children when there is no error', () => {
    const boundary = makeBoundary();
    expect(boundary.render()).toBe('CHILDREN');
  });

  it('getDerivedStateFromError flags the error so the fallback renders', () => {
    const boundary = makeBoundary({ fallback: 'FALLBACK' });
    boundary.state = BugseeErrorBoundary.getDerivedStateFromError(new Error('boom')); // React applies this
    expect(boundary.state.hasError).toBe(true);
    expect(boundary.render()).toBe('FALLBACK');
  });

  it('renders a function fallback with the captured error', () => {
    const err = new Error('boom');
    const boundary = makeBoundary({ fallback: (e) => `caught: ${(e as Error).message}` });
    boundary.state = BugseeErrorBoundary.getDerivedStateFromError(err);
    expect(boundary.render()).toBe('caught: boom');
  });

  it('renders null when an error occurs and no fallback is provided', () => {
    const boundary = makeBoundary({ fallback: undefined });
    boundary.state = BugseeErrorBoundary.getDerivedStateFromError(new Error('boom'));
    expect(boundary.render()).toBeNull();
  });

  it('renders null when there are no children and no error', () => {
    const boundary = makeBoundary({ children: undefined });
    expect(boundary.render()).toBeNull();
  });

  it('componentDidCatch reports the error with the component stack + invokes onError', () => {
    const { client, logException } = fakeClient();
    const onError = vi.fn();
    const boundary = makeBoundary({ getClient: () => client, onError });
    const err = new Error('render boom');
    boundary.componentDidCatch(err, errorInfo('\n    in Widget'));
    expect(logException).toHaveBeenCalledTimes(1);
    expect(logException.mock.calls[0]?.[0]).toBe(err);
    expect((err.cause as Error).stack).toContain('in Widget'); // component stack linked through reportReactError
    expect(onError).toHaveBeenCalledWith(err, '\n    in Widget');
  });

  it('componentDidCatch tolerates a null componentStack (no stack linked) and threads the mechanism', () => {
    const { client, logException } = fakeClient();
    const boundary = makeBoundary({ getClient: () => client, mechanism: 'programmatic' });
    const err = new Error('boom');
    boundary.componentDidCatch(err, errorInfo(null));
    expect(logException.mock.calls[0]?.[1]?.mechanism).toBe('programmatic');
    expect(err.cause).toBeUndefined(); // null component stack → nothing linked
  });

  it('componentDidCatch falls back to the default carrier client when no getClient prop is given', () => {
    const boundary = makeBoundary(); // no getClient → reportReactError uses the carrier (none launched)
    expect(() => boundary.componentDidCatch(new Error('boom'), errorInfo(null))).not.toThrow();
  });
});

describe('withBugseeErrorBoundary', () => {
  const Wrapped: ComponentType<{ label: string }> = () => null;

  it('wraps a component in a BugseeErrorBoundary, forwarding props + boundary options', () => {
    const getClient = () => undefined;
    const Hoc = withBugseeErrorBoundary(Wrapped, { getClient, fallback: 'F' });
    const element = (Hoc as (p: { label: string }) => ReactElement)({ label: 'hi' });
    expect(element.type).toBe(BugseeErrorBoundary); // outer is the boundary
    expect(element.props.getClient).toBe(getClient); // boundary options forwarded
    expect(element.props.fallback).toBe('F');
    const child = element.props.children as ReactElement;
    expect(child.type).toBe(Wrapped); // inner is the wrapped component
    expect(child.props).toEqual({ label: 'hi' }); // wrapped props forwarded
  });

  it('derives a displayName from the wrapped component', () => {
    const Named: ComponentType = () => null;
    Named.displayName = 'MyView';
    expect((withBugseeErrorBoundary(Named) as ComponentType).displayName).toBe(
      'withBugseeErrorBoundary(MyView)',
    );
  });

  it('falls back to the component function name, then to "Component", for the displayName', () => {
    function Panel(): ReactNode {
      return null;
    }
    expect((withBugseeErrorBoundary(Panel) as ComponentType).displayName).toBe(
      'withBugseeErrorBoundary(Panel)',
    );
    // An anonymous component (empty name, no displayName) → "Component".
    const anon = withBugseeErrorBoundary((() => null) as ComponentType);
    expect((anon as ComponentType).displayName).toBe('withBugseeErrorBoundary(Component)');
  });

  it('works with no boundary options (createElement receives undefined props)', () => {
    const Hoc = withBugseeErrorBoundary(Wrapped);
    const element = (Hoc as (p: { label: string }) => ReactElement)({ label: 'x' });
    expect(element.type).toBe(BugseeErrorBoundary);
    expect((element.props.children as ReactElement).props).toEqual({ label: 'x' });
  });
});

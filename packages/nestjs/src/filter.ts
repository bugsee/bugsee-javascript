import type { Bugsee } from '@bugsee/node';
import { type ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import {
  defaultGetClient,
  defaultShouldReport,
  matchedRoute,
  type NestAdapterOptions,
  type NestHttpRequest,
  reportErrorOnce,
} from './shared';

// The OPT-IN error seam for @bugsee/nestjs (errorCapture: 'filter' | 'both'). Unlike the interceptor, a
// global exception filter is Nest's single convergence point for EVERY error — including those thrown in
// GUARDS and pipes, which the interceptor cannot see (verified, see docs/design/framework-adapters.md).
// The cost: it imports @nestjs/core (BaseExceptionFilter) at runtime (a peer) and, being a catch-all,
// can collide with a user's own global filter — for that case use {@link BugseeExceptionCaptured} on
// their filter instead. This filter REPORTS then DELEGATES to super.catch(), so Nest formats the response
// exactly as it would by default — the report is a pure side effect.

// `Catch()` is applied FUNCTIONALLY (not as decorator syntax) so the source needs no decorator transform.
// An empty Catch() means "catch all exceptions" (the global catch-all).
class BugseeExceptionFilter extends BaseExceptionFilter {
  private readonly getClient: () => Bugsee | undefined;
  private readonly shouldReport: (err: unknown) => boolean;
  private readonly reported: WeakSet<object> | undefined;

  constructor(
    options: NestAdapterOptions = {},
    reported?: WeakSet<object>,
    // The http adapter BaseExceptionFilter needs to format the response. setupNest passes
    // `app.getHttpAdapter()`; omitted in unit tests where super.catch is stubbed.
    applicationRef?: ConstructorParameters<typeof BaseExceptionFilter>[0],
  ) {
    super(applicationRef);
    this.getClient = options.getClient ?? defaultGetClient;
    this.shouldReport = options.shouldReport ?? defaultShouldReport;
    this.reported = reported;
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    try {
      const client = this.getClient();
      if (client !== undefined) {
        const req = host.switchToHttp().getRequest<NestHttpRequest>();
        reportErrorOnce(client, exception, {
          shouldReport: this.shouldReport,
          route: matchedRoute(req),
          reported: this.reported,
        });
      }
    } catch {
      // reporting must never replace Nest's exception handling
    }
    super.catch(exception, host); // delegate → Nest's standard response formatting, unchanged
  }
}
Catch()(BugseeExceptionFilter); // apply the catch-all metadata (side effect on the class)

export { BugseeExceptionFilter };

/**
 * Method decorator for users who already have their OWN global exception filter (two catch-all filters
 * would collide). Apply it to your filter's `catch` method: it reports the exception to Bugsee, then runs
 * your original `catch` unchanged. This is the escape hatch instead of registering {@link BugseeExceptionFilter}.
 */
export function BugseeExceptionCaptured(options: NestAdapterOptions = {}): MethodDecorator {
  const getClient = options.getClient ?? defaultGetClient;
  const shouldReport = options.shouldReport ?? defaultShouldReport;
  const decorator = (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const original = descriptor.value as (
      this: unknown,
      exception: unknown,
      host: ArgumentsHost,
      ...rest: unknown[]
    ) => unknown;
    descriptor.value = function (
      this: unknown,
      exception: unknown,
      host: ArgumentsHost,
      ...rest: unknown[]
    ): unknown {
      try {
        const client = getClient();
        if (client !== undefined) {
          const req = host.switchToHttp().getRequest<NestHttpRequest>();
          reportErrorOnce(client, exception, { shouldReport, route: matchedRoute(req) });
        }
      } catch {
        // never let reporting break the user's filter
      }
      return original.apply(this, [exception, host, ...rest]);
    };
    return descriptor;
  };
  return decorator as MethodDecorator;
}

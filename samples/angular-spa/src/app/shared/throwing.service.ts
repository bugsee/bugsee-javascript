import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { map } from 'rxjs/operators';

// §5.6 "beyond the catalog" fixture: an error thrown IN A SERVICE (as opposed to a component template/
// lifecycle hook or an RxJS pipeline — each gets its own method here so the Scenario panel can arm them
// independently and the resulting report's stack trace can be told apart).
@Injectable({ providedIn: 'root' })
export class ThrowingService {
  /** A synchronous throw from a plain service method — the call site (a component event handler) has
   *  no try/catch, so this becomes an uncaught error that Angular's zone routes to `ErrorHandler`. */
  throwSynchronously(): never {
    throw new Error('ThrowingService: synchronous throw from a service method');
  }

  /** An error raised INSIDE an RxJS operator, with the returned Observable subscribed WITHOUT an error
   *  callback. `of(1)` emits SYNCHRONOUSLY, so with no error consumer RxJS re-throws synchronously out
   *  of `.subscribe()` itself — the caller (a component click handler) never reaches its next line,
   *  exactly like a plain synchronous throw, just raised from inside the pipeline instead of the
   *  handler body. */
  explodingPipeline(): Observable<never> {
    return of(1).pipe(
      map((): never => {
        throw new Error('ThrowingService: thrown inside an RxJS pipeline (map operator)');
      }),
    );
  }
}

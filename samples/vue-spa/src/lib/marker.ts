import { RUN_ID } from '../bugsee';

/** A unique, greppable marker for one scenario invocation: `<RUN_ID>:<scenarioId>:<nonce>`. Stamped into
 *  labels/breadcrumbs/log messages so a specific run's issue can be told apart from a previous run's
 *  when polling the backend (scripts/verify.mts and the manual verification pass both rely on this). */
export function marker(scenarioId: string): string {
  return `${RUN_ID}:${scenarioId}:${Math.random().toString(36).slice(2, 8)}`;
}

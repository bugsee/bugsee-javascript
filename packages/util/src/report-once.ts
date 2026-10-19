import { reportGuarded } from './report-guarded';

// Distinct failures remembered per reporter. A repeating failure is almost always ONE root cause polled many
// times (a reader that throws on every report build); the host needs to hear about it once, and the bound keeps a
// pathological stream of ever-different messages from growing memory without limit.
const MAX_DISTINCT = 32;

/**
 * Wrap a host `onError` sink so each distinct failure (error type + message, or the text of a non-Error) is
 * delivered once; once {@link MAX_DISTINCT} distinct failures were forwarded, further new ones are dropped too.
 * Delivery itself is {@link reportGuarded}: a throwing or rejecting sink never escapes.
 */
export function reportOncePerMessage(
  onError: ((error: unknown) => unknown) | undefined,
): (error: unknown) => void {
  const seen = new Set<string>();
  return (error) => {
    let key: string;
    try {
      key = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    } catch {
      key = '<unreadable>';
    }
    if (seen.has(key) || seen.size >= MAX_DISTINCT) return;
    seen.add(key);
    reportGuarded(onError, error);
  };
}

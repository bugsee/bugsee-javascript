import { type AttributeValue, requestAttributes } from '@bugsee/vercel-edge';

// Cloudflare `request.cf` enrichment (docs/design/edge-runtime.md C3, decision D9). Behind the edge, every
// incoming fetch Request carries a `cf` object of FREE geo/network metadata. We stamp a CURATED, low-PII subset
// (the design's colo / country / city / timezone / asn / tls — NOT latitude/longitude) onto the request's
// context, so a fetch incident report carries where/how the request arrived. Every field is optional (absent in
// `wrangler dev` or when not behind the edge), so each is individually guarded; a missing `cf` stamps nothing.

interface CfProperties {
  colo?: unknown;
  country?: unknown;
  city?: unknown;
  timezone?: unknown;
  asn?: unknown;
  asOrganization?: unknown;
  httpProtocol?: unknown;
  tlsVersion?: unknown;
}

/** Read `request.cf` and return the curated geo/network attributes (`cf.*` + `http.protocol`/`tls.version`).
 *  Returns `{}` when `cf` is absent or not an object (e.g. local `wrangler dev`). */
export function cfAttributes(request: Request): Record<string, AttributeValue> {
  // `cf` is a Cloudflare runtime extension absent from the standard Request type → read it through a cast.
  const cf = (request as { cf?: unknown }).cf;
  if (cf === null || typeof cf !== 'object') {
    return {};
  }
  const props = cf as CfProperties;
  const attributes: Record<string, AttributeValue> = {};
  const putString = (key: string, value: unknown): void => {
    if (typeof value === 'string') {
      attributes[key] = value;
    }
  };
  putString('cf.colo', props.colo);
  putString('cf.country', props.country);
  putString('cf.city', props.city);
  putString('cf.timezone', props.timezone);
  putString('cf.as_organization', props.asOrganization);
  putString('http.protocol', props.httpProtocol);
  putString('tls.version', props.tlsVersion);
  if (typeof props.asn === 'number') {
    attributes['cf.asn'] = props.asn;
  }
  return attributes;
}

/** The full attribute set for a Cloudflare fetch incident: the shared `http.method`/`http.url` (route) PLUS the
 *  `request.cf` geo/network enrichment. Exposed so a manually-instrumented Durable-Object `fetch` can reuse it. */
export function cloudflareRequestAttributes(request: Request): Record<string, AttributeValue> {
  return { ...requestAttributes(request), ...cfAttributes(request) };
}

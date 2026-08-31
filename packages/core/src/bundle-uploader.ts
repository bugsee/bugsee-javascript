import {
  type BundleUploader,
  type HttpResponse,
  type HttpTransport,
  isRetryableHttpStatus,
  type PutBundleOptions,
  type PutResult,
} from './transport';

// The data-plane BundleUploader (design §7.5/§8.3) — platform-agnostic logic over an injected
// HttpTransport. It builds the signed-PUT headers (Content-Length, fileName; NO Authorization — the
// signed URL self-auths — and NO Content-Type, and NO `x-amz-*`, see below) and maps the response to
// a PutResult: 2xx → ok; a network error (transport reject) → retryable; anything else is classified
// by `isRetryableHttpStatus`, the ONE Android-parity classifier (5xx + 401/408/425/429 retryable, any
// other 4xx — incl. 403, which the UploadPipeline recovers via renewUpload — permanent). This is not
// a local judgement call: `retryable:false` becomes `permanent:true` in the pipeline, which becomes
// "delete the blob, the marker, the capture chunks and the instance subtree" in every recovery leg.
// The only platform-specific piece is the transport (node:http(s) / fetch), supplied by the platform.

export function createBundleUploader(transport: HttpTransport): BundleUploader {
  return {
    async putBundle(url: string, body: Uint8Array, options: PutBundleOptions): Promise<PutResult> {
      let response: HttpResponse;
      try {
        response = await transport(url, {
          method: 'PUT',
          headers: {
            'Content-Length': String(options.contentLength),
            // Deliberately NO `x-amz-checksum-sha256`. S3 folds every `x-amz-*` header into the
            // string it signs, and the collector mints this url WITHOUT a checksum — it only signs
            // one when the issue-create body carried `bundle_sha256`/`bundle_md5`, which this SDK
            // does not send. Adding the header therefore made S3 compute a different string and
            // reject every upload with 403 SignatureDoesNotMatch, at the very last hop, after the
            // issue had already been accepted. `options.checksumSha256` is still computed and is what
            // a future `bundle_sha256` at issue-create would carry, which is how the header becomes
            // signable — and only then send it again.
            fileName: options.fileName,
          },
          body,
        });
      } catch (cause) {
        // Carry the error: status 0 alone says only "the request never completed", which is the same
        // answer for a DNS failure, a TLS failure and an aborted socket.
        return { ok: false, status: 0, retryable: true, cause };
      }
      if (response.status >= 200 && response.status < 300) {
        return { ok: true };
      }
      return {
        ok: false,
        status: response.status,
        retryable: isRetryableHttpStatus(response.status),
      };
    },
  };
}

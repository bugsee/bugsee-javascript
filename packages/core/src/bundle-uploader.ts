import type {
  BundleUploader,
  HttpResponse,
  HttpTransport,
  PutBundleOptions,
  PutResult,
} from './transport';

// The data-plane BundleUploader (design §7.5/§8.3) — platform-agnostic logic over an injected
// HttpTransport. It builds the iOS-style signed-PUT headers (Content-Length, x-amz-checksum-sha256,
// fileName; NO Authorization — the signed URL self-auths — and NO Content-Type) and maps the
// response to a PutResult: 2xx → ok; 5xx → retryable; other 4xx (incl. 403, which the UploadPipeline
// recovers via renewUpload) → non-retryable; a network error (transport reject) → retryable. The
// only platform-specific piece is the transport (node:http(s) / fetch), supplied by the platform.

export function createBundleUploader(transport: HttpTransport): BundleUploader {
  return {
    async putBundle(url: string, body: Uint8Array, options: PutBundleOptions): Promise<PutResult> {
      let response: HttpResponse;
      try {
        response = await transport(url, {
          method: 'PUT',
          headers: {
            'Content-Length': String(options.contentLength),
            'x-amz-checksum-sha256': options.checksumSha256,
            fileName: options.fileName,
          },
          body,
        });
      } catch {
        return { ok: false, status: 0, retryable: true };
      }
      if (response.status >= 200 && response.status < 300) {
        return { ok: true };
      }
      return { ok: false, status: response.status, retryable: response.status >= 500 };
    },
  };
}

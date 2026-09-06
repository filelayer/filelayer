/**
 * The only genuinely Vercel-Blob-specific module in this baseline.
 *
 * Everything else — roles, org boundaries, share links, expiry, passwords,
 * download caps, the audit trail — is hand-written application code that would
 * be byte-for-byte the same on any object store. Vercel Blob supplies bytes
 * in and bytes out, and nothing else. That is not a criticism; it is the
 * product's stated scope ("There is no ownership model").
 *
 * Docs followed:
 *  - https://vercel.com/docs/vercel-blob/private-storage
 *  - https://vercel.com/docs/vercel-blob/using-blob-sdk
 */
import { get, head, del } from '@vercel/blob';

/**
 * Object pathname layout.
 *
 * The org id appears here for operability only. It is NOT a security
 * boundary: the store credential (`BLOB_READ_WRITE_TOKEN`, or the project's
 * OIDC identity) can read and `list()` every pathname in the store regardless
 * of prefix. Vercel Blob has no per-prefix credential scoping. Cross-org
 * isolation is 100% application logic, exactly as on raw S3.
 */
export function pathnameFor(orgId: string, documentId: string): string {
  return `orgs/${orgId}/documents/${documentId}`;
}

export type BlobStreamResult = {
  stream: ReadableStream;
  contentType: string;
  etag: string;
};

/**
 * Fetch a private blob for streaming to an already-authorised caller.
 *
 * `access: 'private'` is REQUIRED on get(). It is a required option rather
 * than an inferred property of the store, which means every call site is a
 * place a developer can type the wrong string. Passing `'public'` against a
 * private store fails loudly, so this one is fail-closed.
 *
 * `useCache` defaults to true. We pass it explicitly per call site because the
 * correct answer differs: immutable document bytes want the cache; anything
 * read straight after a write does not (up to 60s of staleness otherwise).
 */
export async function getBlobStream(
  pathname: string,
  opts: { ifNoneMatch?: string; useCache?: boolean } = {}
): Promise<{ status: 200 | 304 | 404; body?: BlobStreamResult; etag?: string }> {
  const result = await get(pathname, {
    access: 'private',
    ifNoneMatch: opts.ifNoneMatch,
    useCache: opts.useCache ?? true,
  });

  // Documented: "get() returns null if the blob is not found".
  if (!result) return { status: 404 };

  if (result.statusCode === 304) {
    return { status: 304, etag: result.blob.etag };
  }
  if (result.statusCode !== 200) return { status: 404 };

  return {
    status: 200,
    body: {
      stream: result.stream,
      contentType: result.blob.contentType,
      etag: result.blob.etag,
    },
  };
}

/**
 * Confirm a client upload actually landed. `head()` throws BlobNotFoundError
 * rather than returning null — a different convention from `get()`, which
 * returns null. Two error conventions in one SDK is a small thing but it is
 * the kind of small thing that produces an unhandled rejection in production.
 */
export async function blobExists(pathname: string): Promise<{ exists: boolean; size?: number }> {
  try {
    const meta = await head(pathname);
    return { exists: true, size: meta.size };
  } catch (err) {
    if ((err as Error)?.name === 'BlobNotFoundError') return { exists: false };
    throw err;
  }
}

/**
 * Delete. Documented behaviour: "A delete action won't throw if the blob url
 * doesn't exist" — so this is idempotent, which is genuinely nice. But also:
 * "Since blobs are cached, it may take up to one minute for them to be fully
 * removed from the Vercel CDN cache." Deletion is therefore NOT immediate at
 * the edge; only our own authorization check in front of it is.
 */
export async function deleteBlob(pathname: string): Promise<void> {
  await del(pathname);
}

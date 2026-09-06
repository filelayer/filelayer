import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';

/**
 * S3 / R2 access layer.
 *
 * Presigned-URL policy, following AWS Prescriptive Guidance ("Establishing
 * guardrails and monitoring for presigned URLs") and the S3 User Guide
 * ("Download and upload objects with presigned URLs"):
 *
 *  - TTLs are deliberately tiny. AWS's own guidance is that you do not revoke
 *    presigned URLs, you keep the window short enough that revocation is not
 *    the tool you reach for. We use 60s for downloads and 300s for uploads.
 *  - The bucket policy (see infra/bucket-policy.json) additionally denies any
 *    request whose `s3:signatureAge` exceeds the TTL, so a signature is
 *    rejected at the S3 edge even if application code ever asks for a longer
 *    expiry by mistake. This is the one guardrail that fails CLOSED.
 *  - Presigned URLs are only ever handed to a caller we have ALREADY
 *    authorised as an org member. They are never used for anonymous share
 *    links, because a presigned URL cannot be revoked (see REPORT.md §9).
 */

export const DOWNLOAD_URL_TTL_SECONDS = 60;
export const UPLOAD_URL_TTL_SECONDS = 300;

export function createStorage({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle = true }) {
  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    client,
    bucket,

    /**
     * Object key layout. The org id is in the key purely for operability
     * (lifecycle rules, cost attribution, forensics). It is NOT an
     * authorization boundary: any principal that can read one key in this
     * bucket can read every key in this bucket. Cross-org isolation lives
     * entirely in application code.
     */
    keyFor(orgId, documentId) {
      return `orgs/${orgId}/documents/${documentId}`;
    },

    async presignUpload(key, contentType, ttl = UPLOAD_URL_TTL_SECONDS) {
      return getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
        { expiresIn: ttl }
      );
    },

    async presignDownload(key, { filename, contentType, ttl = DOWNLOAD_URL_TTL_SECONDS } = {}) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: filename
            ? `attachment; filename="${filename.replace(/"/g, '')}"`
            : undefined,
          ResponseContentType: contentType,
        }),
        { expiresIn: ttl }
      );
    },

    async head(key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { exists: true, size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
      } catch (err) {
        if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
          return { exists: false };
        }
        throw err;
      }
    },

    /** Server-side read, used by the revocable share-link proxy path. */
    async getStream(key) {
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = r.Body;
      const stream = typeof body?.pipe === 'function'
        ? body
        : Readable.fromWeb(body.transformToWebStream());
      return { stream, size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
    },

    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

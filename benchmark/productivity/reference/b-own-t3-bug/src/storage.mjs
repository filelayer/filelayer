// The object store. Private bucket, path-style, bytes only.
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

export function openStorage(env) {
  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  const Bucket = env.S3_BUCKET;
  return {
    put: (key, body, contentType) =>
      s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType })),
    get: async (key) => {
      const r = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
      return Buffer.from(await r.Body.transformToByteArray());
    },
    del: (key) => s3.send(new DeleteObjectCommand({ Bucket, Key: key })),
  };
}

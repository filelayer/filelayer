// TIER 1 ON RAW S3 + A PUBLIC BUCKET
//
// The idiomatic AWS pattern for public user content, from AWS's own docs:
// upload with PutObject, serve straight from the bucket's public URL (or a
// CloudFront distribution in front of it).
//
// NOT EXECUTED. This needs live AWS credentials, exactly like `S3Storage` in
// packages/core/src/storage.ts, which is also shipped untested for the same
// reason. It is here to be COUNTED, and it is written to be as short as an
// experienced developer would write it -- no error handling either side, so the
// comparison is like for like.
//
// The infra cost is in ./infra/, and it is not zero: making a bucket public
// means turning OFF the account-level and bucket-level Block Public Access
// settings, which AWS deliberately makes noisy because it is the single most
// common cause of data exposure.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: 'us-east-1' });

export async function putAvatar(userId, bytes) {
  const key = `avatars/${userId}.png`;
  await s3.send(
    new PutObjectCommand({
      Bucket: 'my-app-avatars',
      Key: key,
      Body: bytes,
      ContentType: 'image/png',
    }),
  );
  return `https://my-app-avatars.s3.us-east-1.amazonaws.com/${key}`;
}

// There is no serving code. That is a real advantage and it is why S3 wins on
// operations even where it ties on lines: the bucket IS the origin, CloudFront
// caches it, range requests and conditional GETs work, and none of it is your
// code. See ARCHITECTURE-PROGRESSIVE.md, "Where Filelayer is not worth using".

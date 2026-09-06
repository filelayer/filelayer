// TIER 1 ON FILELAYER -- the upload half only.
//
// This is the file that is comparable line-for-line with the S3 and Supabase
// snippets: it assumes you already have somewhere to serve bytes from.
// The serving half is in filelayer-delivery.js and is counted separately,
// because S3 and Supabase get serving from their CDN for free and we do not.

import { Filelayer } from '@filelayer/core';

const fl = await Filelayer.quickstart({ baseUrl: 'https://files.example.com' });

export async function putAvatar(userId, bytes) {
  const { url } = await fl.files.put(bytes, { public: true, name: `${userId}.png` });
  return url;
}

// TIER 1 ON SUPABASE STORAGE
//
// Straight from Supabase's own "Storage Quickstart" and "Public buckets" docs:
// create a public bucket in the dashboard, `upload()`, `getPublicUrl()`.
//
// NOT EXECUTED. Needs a live Supabase project. Counted only.
//
// This is the strongest tier-1 competitor by a distance, and this file says so:
// it is three statements, the bucket is created by clicking a toggle, and the
// URL it returns is served by Supabase's CDN with caching, range requests and
// image transformations already working.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function putAvatar(userId, bytes) {
  const path = `${userId}.png`;
  const { error } = await supabase.storage
    .from('avatars')
    .upload(path, bytes, { contentType: 'image/png', upsert: true });
  if (error) throw error;
  return supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
}

// No serving code, same as S3. And note what `getPublicUrl` is: a pure string
// concatenation, offline, with no server round trip -- which is exactly why it
// cannot be revoked. Deleting the object is the only withdrawal mechanism, and
// the CDN keeps serving the old bytes until the cache expires.

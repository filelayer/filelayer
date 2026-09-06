// TIER 1 ON FILELAYER -- the serving half.
//
// The cost S3 and Supabase do not pay, counted rather than hidden.
// `principal: () => ({ actorId: null })` is the entire configuration: serve as
// an anonymous caller, so only files carrying a live anonymous grant are
// reachable and everything else is 404.

import { createServer } from 'node:http';
import { Filelayer, fileDownloadRoute } from '@filelayer/core';

export function mountDelivery(fl, port) {
  const route = fileDownloadRoute(fl, {
    prefix: '/f',
    disposition: 'inline',
    principal: () => ({ actorId: null }),
  });
  createServer((req, res) => route(req, res)).listen(port);
}

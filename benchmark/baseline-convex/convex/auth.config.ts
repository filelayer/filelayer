// convex/auth.config.ts  --  APPLICATION CODE (counted)
// WRITTEN TO SPEC. NOT EXECUTED.
// https://docs.convex.dev/auth/clerk
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
};

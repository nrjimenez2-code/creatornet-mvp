// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://f9241b8e5d5fa849d6240ab0005c7de0@o4510308994056192.ingest.us.sentry.io/4510309018238976",

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 0.1,

  // Off deliberately: this forwards console output to Sentry, which means any
  // future accidental log of a token, cookie or customer email leaves the
  // server. sendDefaultPii: false does not cover console output.
  enableLogs: false,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: false,
});

import './lib/serverStartupProbe';
import * as Sentry from '@sentry/nextjs';
import { markServerStartup } from './lib/serverStartupTiming';

markServerStartup('imported');

export async function register() {
  markServerStartup('registering');
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
  markServerStartup('ready');
}

export const onRequestError = Sentry.captureRequestError;

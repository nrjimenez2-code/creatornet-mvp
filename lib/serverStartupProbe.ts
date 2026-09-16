import { markServerStartup } from './serverStartupTiming';

// First instrumentation dependency: starts before subsequent dependency
// evaluation, not before platform provisioning or Next's earlier bootstrap.
markServerStartup('start');

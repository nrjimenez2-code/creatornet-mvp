/* eslint-disable @typescript-eslint/no-require-imports -- Jest loads this native CommonJS environment outside its TypeScript VM. */
const { TestEnvironment } = require("jest-environment-node");
const { PGlite } = require("@electric-sql/pglite");

// Load the WASM engine in Node's native module context, outside Jest's VM.
// This keeps ordinary `npm test` working without experimental VM flags. The
// factory accepts no configuration: every instance is an isolated in-memory
// database, never a filesystem database or a remote Supabase connection.
module.exports = class LocalPostgresEnvironment extends TestEnvironment {
  async setup() {
    await super.setup();
    this.global.createLocalPostgres = () => new PGlite();
  }
};

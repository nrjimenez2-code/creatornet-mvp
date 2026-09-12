const { TestEnvironment } = require("jest-environment-node");
const { PGlite } = require("@electric-sql/pglite");
const { pg_trgm } = require("@electric-sql/pglite/contrib/pg_trgm");
module.exports = class SearchPostgresEnvironment extends TestEnvironment {
  async setup() {
    await super.setup();
    this.global.createSearchPostgres = () => new PGlite({ extensions: { pg_trgm } });
  }
};

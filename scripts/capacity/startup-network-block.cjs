// Loaded only by the isolated startup experiment, never by the application.
const block = () => { throw new Error('Startup experiment outbound networking blocked'); };
globalThis.fetch = block;
for (const name of ['node:http', 'node:https']) {
  require(name).request = block;
  require(name).get = block;
}
require('node:net').connect = block;
require('node:net').createConnection = block;
require('node:tls').connect = block;

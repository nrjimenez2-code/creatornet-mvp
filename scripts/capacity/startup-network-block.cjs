// Loaded only by the isolated startup experiment, never by the application.
const block = () => { throw new Error('Startup experiment outbound networking blocked'); };
globalThis.fetch = block;
for (const name of ['node:http', 'node:https']) {
  require(name).request = block;
  require(name).get = block;
}
// Turbopack's compiler and Node build workers communicate over loopback TCP.
// Permit only literal loopback IPs, never DNS names or remote hosts.
const net = require('node:net');
const connect = net.createConnection;
const localConnect = function(...args) {
  const options = args[0];
  const host = options && typeof options === 'object' ? options.host : args[1];
  if (host !== '127.0.0.1' && host !== '::1') return block();
  return connect.apply(net, args);
};
net.connect = localConnect;
net.createConnection = localConnect;
require('node:tls').connect = block;

const {test} = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
require('./startup-network-block.cjs');
test('remote fetch, HTTP, TLS and raw TCP fail before connecting', () => {
  assert.throws(() => fetch('https://example.invalid'), /blocked/);
  assert.throws(() => require('node:https').get('https://example.invalid'), /blocked/);
  assert.throws(() => require('node:tls').connect({host:'example.invalid',port:443}), /blocked/);
  assert.throws(() => net.connect({host:'example.invalid',port:443}), /blocked/);
  assert.throws(() => net.createConnection(443,'192.0.2.1'), /blocked/);
  assert.throws(() => net.connect({path:'/tmp/unapproved.sock'}), /blocked/);
});
test('literal loopback build-worker TCP can complete a round trip', async () => {
  const server = net.createServer(socket => socket.end('local-worker'));
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  try {
    const data = await new Promise((resolve,reject) => {
      const socket = net.connect({host:'127.0.0.1',port:server.address().port});
      let data='';
      socket.setTimeout(2000,()=>socket.destroy(new Error('Local connection timeout')));
      socket.on('data',chunk=>{data+=chunk;});
      socket.on('error',reject);
      socket.on('end',()=>resolve(data));
    });
    assert.equal(data,'local-worker');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

import net from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePort, validateEntryInput } from '../src/server.ts';

const createOccupiedServer = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, () => {
    resolve(server);
  });
});

test('resolvePort finds a free port when the preferred port is busy', async () => {
  const server = await createOccupiedServer();
  const occupiedPort = server.address().port;

  const nextPort = await resolvePort(occupiedPort);

  assert.notEqual(nextPort, occupiedPort);
  assert.ok(nextPort > 0);
  server.close();
});

test('validateEntryInput rejects blank entry data', () => {
  const result = validateEntryInput({ title: '', body: 'ok' });
  assert.equal(result.ok, false);
  assert.match(result.error, /title/i);
});

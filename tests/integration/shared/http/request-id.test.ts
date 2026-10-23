import { Writable } from 'node:stream';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../../../src/app.js';
import { createLogger } from '../../../../src/shared/http/logger.js';

const readiness = { database: async () => undefined, chain: async () => undefined };

const captured = () => {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });

  return { lines, app: createApp({ readiness, logger: createLogger('info', stream) }) };
};

const requestIdOf = (line: Record<string, unknown>): unknown =>
  (line['req'] as { id?: unknown } | undefined)?.id;

describe('request id and request logs — ADR-017, docs/security.md §3', () => {
  it('echoes an incoming X-Request-Id on the response and on the log line', async () => {
    const { lines, app } = captured();

    await request(app)
      .get('/healthz')
      .set('X-Request-Id', 'tc-req-2026-10-23-0001')
      .expect('X-Request-Id', 'tc-req-2026-10-23-0001');

    expect(lines.map(requestIdOf)).toContain('tc-req-2026-10-23-0001');
  });

  it('generates an id when none is sent, the same one in the header and the log line', async () => {
    const { lines, app } = captured();
    const response = await request(app).get('/healthz').expect(200);
    const id = response.headers['x-request-id'];

    expect(id).toMatch(/^[\w.-]{8,}$/);
    expect(lines.map(requestIdOf)).toContain(id);
  });

  it('replaces an incoming id that is unsafe to log', async () => {
    const { app } = captured();
    const response = await request(app)
      .get('/healthz')
      .set('X-Request-Id', 'evil id <script>')
      .expect(200);

    expect(response.headers['x-request-id']).not.toContain('script');
  });

  it('never logs the bearer token', async () => {
    const { lines, app } = captured();

    await request(app)
      .get('/healthz')
      .set('Authorization', 'Bearer eyJhbGciOiJFUzI1NiJ9.privy-session')
      .expect(200);

    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain('privy-session');
  });
});

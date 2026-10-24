import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { testApp } from '../../../helpers/app.js';

const WEB = 'http://127.0.0.1:5173';

const preflight = (origin: string) =>
  request(testApp())
    .options('/api/v1/me')
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'GET')
    .set('Access-Control-Request-Headers', 'authorization');

describe('CORS — be-architecture §5 row 3: WEB_ORIGIN only, answered before auth', () => {
  it("answers the web app's preflight with 204 and the allow headers, never 401", async () => {
    const response = await preflight(WEB);

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(WEB);
    expect(response.headers['access-control-allow-headers']).toMatch(/Authorization/);
    expect(response.headers['access-control-allow-methods']).toMatch(/POST/);
  });

  it('gives another origin no allow headers, so its browser refuses the request', async () => {
    const response = await preflight('https://evil.example');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets a real request from the web app through to auth, with the origin echoed', async () => {
    const response = await request(testApp()).get('/api/v1/me').set('Origin', WEB);

    expect(response.status).toBe(401);
    expect(response.headers['access-control-allow-origin']).toBe(WEB);
    expect(response.headers['access-control-expose-headers']).toBe('X-Request-Id');
  });
});

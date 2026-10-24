// The worker's own small HTTP server: GET /health for the process supervisor, GET /metrics for monitoring.
import { createServer, type Server, type ServerResponse } from 'node:http';

const STATUS = { ok: 200, unavailable: 503, notFound: 404, methodNotAllowed: 405 };

const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};

export const startHealthServer = (options: {
  port: number;
  health: () => { ok: boolean };
  metrics: () => unknown;
}): Promise<Server> => {
  const server = createServer((request, response) => {
    if (request.method !== 'GET') {
      send(response, STATUS.methodNotAllowed, { error: 'method_not_allowed' });

      return;
    }

    const path = (request.url ?? '/').split('?')[0];

    if (path === '/health') {
      const report = options.health();

      send(response, report.ok ? STATUS.ok : STATUS.unavailable, report);
    } else if (path === '/metrics') {
      send(response, STATUS.ok, options.metrics());
    } else {
      send(response, STATUS.notFound, { error: 'not_found' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, () => resolve(server));
  });
};

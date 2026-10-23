import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStorage } from '../../../../src/shared/storage/storage.js';
import { CONTAINER_START_MS } from '../../../helpers/database.js';
import { startMinio, type TestMinio } from '../../../helpers/minio.js';

// ADR-020, NFR-053: a presigned PUT is good for 15 minutes and for exactly the announced bytes.
const VIDEO = Buffer.from('a seven second check-in, as bytes');

let minio: TestMinio;

const sha256Base64 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('base64');

const linkFor = (signedAt: Date, key: string) =>
  createStorage(minio.config, () => signedAt).presignPut({
    bucket: 'evidence',
    key,
    contentType: 'video/webm',
    contentLength: VIDEO.length,
    sha256Base64: sha256Base64(VIDEO),
  });

const put = (link: Awaited<ReturnType<typeof linkFor>>, body: Buffer) =>
  fetch(link.url, { method: link.method, headers: link.headers, body: new Uint8Array(body) });

beforeAll(async () => {
  minio = await startMinio();
}, CONTAINER_START_MS);

afterAll(async () => {
  await minio.stop();
});

describe('a presigned evidence upload (ADR-020)', () => {
  it('accepts the announced bytes, and says when it expires: 15 minutes after signing', async () => {
    const signedAt = new Date();
    const link = await linkFor(signedAt, 'sari/accepted.mp4');

    expect(link.url).toMatch(/X-Amz-Expires=900&/);
    expect(link.url).toMatch(
      /X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256/,
    );
    expect(link.expiresAt).toBe(new Date(signedAt.getTime() + 900_000).toISOString());
    expect((await put(link, VIDEO)).status).toBe(200);
  });

  it('refuses other bytes of the same length (the signed SHA-256)', async () => {
    const other = Buffer.from(VIDEO.toString().replace('seven', 'eight'));
    const response = await put(await linkFor(new Date(), 'sari/swapped.mp4'), other);

    expect(other).toHaveLength(VIDEO.length);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a different size (the signed Content-Length)', async () => {
    const response = await put(
      await linkFor(new Date(), 'sari/longer.mp4'),
      Buffer.concat([VIDEO, VIDEO]),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses an expired link', async () => {
    const sixteenMinutesAgo = new Date(Date.now() - 16 * 60_000);
    const response = await put(await linkFor(sixteenMinutesAgo, 'sari/late.mp4'), VIDEO);

    expect(response.status).toBe(403);
  });
});

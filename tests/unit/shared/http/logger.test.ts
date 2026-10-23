import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../../../src/shared/http/logger.js';

const PRESIGNED =
  'http://127.0.0.1:9000/evidence/7f3c/2b9e.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=8c1f0e9a';

const logged = (fields: Record<string, unknown>): string => {
  let line = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      line += chunk.toString();
      done();
    },
  });

  createLogger('info', stream).info(fields, 'probe');

  return line;
};

describe('log redaction — docs/security.md §3', () => {
  it('redacts a presigned link under any field name, at any depth', () => {
    const line = logged({ submission: { upload: { url: PRESIGNED }, links: [PRESIGNED] } });

    expect(line).not.toContain('X-Amz-Signature');
    expect(line).toContain('[Redacted]');
  });

  it('redacts exact coordinates, tokens, keys, audit notes and flag reason text', () => {
    const line = logged({
      payload: { gps: { lat: -6.8946, lon: 110.6392, accuracyM: 8 } },
      tree: { exactLat: -6.8946, exactLon: 110.6392 },
      accessToken: 'eyJ-privy',
      privateKey: '0x59c6995e998f97a5',
      sample: { notes: 'Flag remains open.' },
      flag: { reasonText: 'Stake moved two metres after the storm' },
    });

    for (const secret of [
      '-6.8946',
      '110.6392',
      'eyJ-privy',
      '0x59c6995e',
      'Flag remains open',
      'storm',
    ]) {
      expect(line).not.toContain(secret);
    }
  });

  it('keeps what logs may contain: ids, reason codes, status transitions', () => {
    const line = logged({
      submissionId: '2b9e',
      reasons: ['gps_inaccurate'],
      from: 'checking',
      to: 'rejected',
    });

    expect(JSON.parse(line)).toMatchObject({
      submissionId: '2b9e',
      reasons: ['gps_inaccurate'],
      from: 'checking',
      to: 'rejected',
    });
  });
});

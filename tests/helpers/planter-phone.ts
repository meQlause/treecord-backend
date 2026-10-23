import { createHash } from 'node:crypto';
import request from 'supertest';
import {
  bytesToBase64Url,
  canonicalize,
  utf8,
  type EvidencePayload,
} from '../../src/generated/frozen/evidence.js';
import type { TestApi } from './api.js';

// The S19 browser: a non-extractable P-256 key, a recorded clip announced and uploaded, and a payload it signs.

export type Phone = {
  deviceKey: string;
  /** Announces `video` for the target and PUTs it through the presigned link; returns the submission id. */
  record: (target: object, video: Buffer) => Promise<string>;
  /** Signs a payload as the browser does: the frozen canonical bytes, ECDSA P-256, IEEE P1363, base64url. */
  sign: (
    payload: EvidencePayload,
  ) => Promise<{ payload: EvidencePayload; canonical: string; signature: string }>;
};

export const sha256Hex = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Registers a fresh device for the signed-in planter. */
export const planterPhone = async (api: TestApi, userId: string): Promise<Phone> => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ]);
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const registered = await request(api.app)
    .post('/api/v1/devices')
    .set(await api.signedIn(userId))
    .send({ publicKeyJwk: { kty, crv, x, y }, label: 'Pixel 8' });

  return {
    deviceKey: registered.body.device.thumbprint,
    record: async (target, video) => {
      const announced = await request(api.app)
        .post('/api/v1/evidence/upload-url')
        .set(await api.signedIn(userId))
        .send({ ...target, sha256: sha256Hex(video), sizeBytes: video.length, durationSec: 7 });
      const { upload, submissionId } = announced.body;
      const put = await fetch(upload.url, {
        method: upload.method,
        headers: upload.headers,
        body: new Uint8Array(video),
      });

      if (!put.ok) {
        throw new Error(`upload failed: ${put.status} ${await put.text()}`);
      }

      return submissionId;
    },
    sign: async (payload) => {
      const canonical = canonicalize(payload);
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.privateKey,
        new Uint8Array(utf8(canonical)),
      );

      return { payload, canonical, signature: bytesToBase64Url(new Uint8Array(signature)) };
    },
  };
};

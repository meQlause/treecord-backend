import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** ADR-020: every link the API hands out lives 15 minutes. */
const LINK_SECONDS = 900;
const MS_PER_SECOND = 1000;

// the upload must carry exactly these, so MinIO refuses any other size, type or bytes (evidence §2)
const SIGNED_UPLOAD_HEADERS = ['content-length', 'content-type', 'x-amz-checksum-sha256'];

export type StorageConfig = {
  S3_ENDPOINT: string;
  /** ADR-010: a read from MinIO waits this long, then the request answers 503. */
  S3_TIMEOUT_MS: number;
  S3_PUBLIC_ENDPOINT: string;
  S3_REGION: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  /** ADR-020: put before every bucket name. Empty on MinIO (`evidence`, `keyframes`); on Cloud Storage, where
   *  bucket names are global, the project id and a dash. */
  S3_BUCKET_PREFIX?: string;
};

type UploadLink = {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export type Storage = {
  /** FR-132: the SHA-256 and size of a stored object, streamed through the internal endpoint; null when absent. */
  sha256Of: (bucket: string, key: string) => Promise<{ sha256: string; sizeBytes: number } | null>;
  /** A read link the browser can open: signed for S3_PUBLIC_ENDPOINT, not the internal host (be-stack §2). */
  presignGet: (bucket: string, key: string) => Promise<string>;
  /** A write link for exactly one object: its size, type and SHA-256 are part of the signature. */
  presignPut: (object: {
    bucket: string;
    key: string;
    contentType: string;
    contentLength: number;
    sha256Base64: string;
  }) => Promise<UploadLink>;
};

/** FR-132: stream an object through SHA-256, so 25 MiB never sits in memory; null when there is no object. */
const hashOf = async (
  client: S3Client,
  bucket: string,
  key: string,
): Promise<{ sha256: string; sizeBytes: number } | null> => {
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const hash = createHash('sha256');
    let sizeBytes = 0;

    for await (const chunk of object.Body as Readable) {
      hash.update(chunk as Buffer);
      sizeBytes += (chunk as Buffer).length;
    }

    return { sha256: hash.digest('hex'), sizeBytes };
  } catch (error) {
    if (error instanceof NoSuchKey) {
      return null;
    }

    throw error;
  }
};

/** MinIO through the plain S3 API (ADR-020). Signing is local: no request reaches MinIO here. `now` is when a link is
 *  signed, injected so a test can sign one that has already expired. */
export const createStorage = (
  config: StorageConfig,
  now: () => Date = () => new Date(),
): Storage => {
  const named = (bucket: string): string => `${config.S3_BUCKET_PREFIX ?? ''}${bucket}`;
  const credentials = { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY };
  // reads go to the internal host; links are signed for the public one the browser reaches
  const client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials,
    // without throwOnRequestTimeout the SDK only logs a breached timeout and keeps waiting
    requestHandler: {
      requestTimeout: config.S3_TIMEOUT_MS,
      connectionTimeout: config.S3_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
    maxAttempts: 1,
  });
  const presigner = new S3Client({
    endpoint: config.S3_PUBLIC_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials,
    // the SDK would otherwise add a CRC32 of the empty body to every presigned PUT, and no upload would match it
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });

  return {
    sha256Of: (bucket, key) => hashOf(client, named(bucket), key),

    presignGet: (bucket, key) =>
      getSignedUrl(presigner, new GetObjectCommand({ Bucket: named(bucket), Key: key }), {
        expiresIn: LINK_SECONDS,
        signingDate: now(),
      }),

    presignPut: async ({ bucket, key, contentType, contentLength, sha256Base64 }) => {
      const signedAt = now();
      const url = await getSignedUrl(
        presigner,
        new PutObjectCommand({
          Bucket: named(bucket),
          Key: key,
          ContentType: contentType,
          ContentLength: contentLength,
          ChecksumSHA256: sha256Base64,
        }),
        {
          expiresIn: LINK_SECONDS,
          signingDate: signedAt,
          signableHeaders: new Set(SIGNED_UPLOAD_HEADERS),
          unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
        },
      );

      return {
        method: 'PUT',
        url,
        headers: { 'Content-Type': contentType, 'x-amz-checksum-sha256': sha256Base64 },
        expiresAt: new Date(signedAt.getTime() + LINK_SECONDS * MS_PER_SECOND).toISOString(),
      };
    },
  };
};

const NOT_FOUND = 404;

/** The worker's view of MinIO (ADR-021): it writes keyframes and hands the AI service read links. */
export type WorkerStorage = {
  putObject: (bucket: string, key: string, body: Uint8Array, contentType: string) => Promise<void>;
  /** A GET link signed for S3_PUBLIC_ENDPOINT, or null when the object does not exist. */
  signedReadUrl: (bucket: string, key: string) => Promise<string | null>;
};

export const createWorkerStorage = (config: StorageConfig): WorkerStorage => {
  const named = (bucket: string): string => `${config.S3_BUCKET_PREFIX ?? ''}${bucket}`;
  const connection = (endpoint: string): S3Client =>
    new S3Client({
      endpoint,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
      requestHandler: {
        requestTimeout: config.S3_TIMEOUT_MS,
        connectionTimeout: config.S3_TIMEOUT_MS,
        throwOnRequestTimeout: true,
      },
    });
  const client = connection(config.S3_ENDPOINT);
  const presigner = connection(config.S3_PUBLIC_ENDPOINT);

  return {
    putObject: async (bucket, key, body, contentType) => {
      await client.send(
        new PutObjectCommand({
          Bucket: named(bucket),
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },

    signedReadUrl: async (bucket, key) => {
      try {
        await client.send(new HeadObjectCommand({ Bucket: named(bucket), Key: key }));
      } catch (error) {
        if (
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ===
          NOT_FOUND
        ) {
          return null;
        }

        throw error;
      }

      return getSignedUrl(presigner, new GetObjectCommand({ Bucket: named(bucket), Key: key }), {
        expiresIn: LINK_SECONDS,
      });
    },
  };
};

const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ETIMEDOUT',
]);
const SERVER_ERROR = 500;

/** ADR-010: MinIO did not answer in time, could not be reached, or failed itself; the request answers 503. */
export const isStorageUnavailable = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

  return (
    error.name === 'TimeoutError' ||
    UNREACHABLE.has(String((error as { code?: unknown }).code)) ||
    (status !== undefined && status >= SERVER_ERROR)
  );
};

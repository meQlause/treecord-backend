import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** ADR-020: every link the API hands out lives 15 minutes. */
const LINK_SECONDS = 900;
const MS_PER_SECOND = 1000;

// the upload must carry exactly these, so MinIO refuses any other size, type or bytes (evidence §2)
const SIGNED_UPLOAD_HEADERS = ['content-length', 'content-type', 'x-amz-checksum-sha256'];

export type StorageConfig = {
  S3_PUBLIC_ENDPOINT: string;
  S3_REGION: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
};

type UploadLink = {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export type Storage = {
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

/** MinIO through the plain S3 API (ADR-020). Signing is local: no request reaches MinIO here. `now` is when a link is
 *  signed, injected so a test can sign one that has already expired. */
export const createStorage = (
  config: StorageConfig,
  now: () => Date = () => new Date(),
): Storage => {
  const presigner = new S3Client({
    endpoint: config.S3_PUBLIC_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
    // the SDK would otherwise add a CRC32 of the empty body to every presigned PUT, and no upload would match it
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });

  return {
    presignGet: (bucket, key) =>
      getSignedUrl(presigner, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: LINK_SECONDS,
        signingDate: now(),
      }),

    presignPut: async ({ bucket, key, contentType, contentLength, sha256Base64 }) => {
      const signedAt = now();
      const url = await getSignedUrl(
        presigner,
        new PutObjectCommand({
          Bucket: bucket,
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

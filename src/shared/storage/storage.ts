import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** ADR-020: every link the API hands out lives 15 minutes. */
const LINK_SECONDS = 900;

export type StorageConfig = {
  S3_PUBLIC_ENDPOINT: string;
  S3_REGION: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
};

export type Storage = {
  /** A read link the browser can open: signed for S3_PUBLIC_ENDPOINT, not the internal host (be-stack §2). */
  presignGet: (bucket: string, key: string) => Promise<string>;
};

/** MinIO through the plain S3 API (ADR-020). Signing is local: no request reaches MinIO here. */
export const createStorage = (config: StorageConfig): Storage => {
  const presigner = new S3Client({
    endpoint: config.S3_PUBLIC_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
  });

  return {
    presignGet: (bucket, key) =>
      getSignedUrl(presigner, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: LINK_SECONDS,
      }),
  };
};

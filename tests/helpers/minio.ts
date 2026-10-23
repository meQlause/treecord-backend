import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const MINIO_PORT = 9000;
const ACCESS_KEY = 'treecord';
const SECRET_KEY = 'treecord-secret';

export type TestMinio = {
  /** The storage settings the API reads from its environment. */
  config: {
    S3_ENDPOINT: string;
    S3_PUBLIC_ENDPOINT: string;
    S3_REGION: string;
    S3_ACCESS_KEY: string;
    S3_SECRET_KEY: string;
  };
  stop: () => Promise<void>;
};

/** The compose MinIO image in tmpfs, with the private `evidence` and `keyframes` buckets (ADR-020). */
export const startMinio = async (): Promise<TestMinio> => {
  const container: StartedTestContainer = await new GenericContainer(
    'quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e',
  )
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: ACCESS_KEY, MINIO_ROOT_PASSWORD: SECRET_KEY })
    .withTmpFs({ '/data': 'rw' })
    .withExposedPorts(MINIO_PORT)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', MINIO_PORT))
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(MINIO_PORT)}`;
  const config = {
    S3_ENDPOINT: endpoint,
    S3_PUBLIC_ENDPOINT: endpoint,
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: ACCESS_KEY,
    S3_SECRET_KEY: SECRET_KEY,
  };
  const admin = new S3Client({
    endpoint,
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });

  for (const bucket of ['evidence', 'keyframes']) {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  }

  return {
    config,
    stop: async () => {
      await container.stop();
    },
  };
};

// Copies AI keyframes into the backend's own "keyframes" bucket (PRODUCT_KNOWLEDGE.md section 15, rule 6).
import type { WorkerStorage } from '../../shared/storage/storage.js';
import { KEYFRAMES_BUCKET, type Logger } from '../worker-db.repository.js';
import {
  checkKeyframeSize,
  decodeDataUrl,
  KEYFRAME_EXTENSIONS,
  keyframePath,
  MAX_KEYFRAMES,
  type KeyframeImage,
} from './scoring.rules.js';

const DOWNLOAD_TIMEOUT_MS = 15_000;

const download = async (url: string, fetchImpl: typeof fetch): Promise<KeyframeImage> => {
  if (!/^https?:\/\//.test(url)) {
    throw new Error('keyframe URL must be http(s)');
  }

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });

  if (!response.ok) {
    throw new Error(`keyframe download returned ${response.status}`);
  }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';

  if (!(contentType in KEYFRAME_EXTENSIONS)) {
    throw new Error(`unsupported keyframe type ${contentType}`);
  }

  return checkKeyframeSize({ bytes: new Uint8Array(await response.arrayBuffer()), contentType });
};

type StoreKeyframes = {
  storage: WorkerStorage;
  submissionId: string;
  keyframes: string[];
  log: Logger;
  fetchImpl?: typeof fetch;
};

/**
 * Stores up to MAX_KEYFRAMES keyframes at keyframes/{submissionId}/{index}.{ext} and returns their paths. Keyframes
 * are context for later growth checks, not proof, so one that cannot be fetched or decoded is logged and skipped.
 */
export const storeKeyframes = async ({
  storage,
  submissionId,
  keyframes,
  log,
  fetchImpl = fetch,
}: StoreKeyframes): Promise<string[]> => {
  const paths: string[] = [];

  for (const [index, source] of keyframes.slice(0, MAX_KEYFRAMES).entries()) {
    try {
      const image = source.startsWith('data:')
        ? decodeDataUrl(source)
        : await download(source, fetchImpl);
      const path = keyframePath(submissionId, index, image.contentType);

      await storage.putObject(KEYFRAMES_BUCKET, path, image.bytes, image.contentType);
      paths.push(path);
    } catch (error) {
      log.warn({ submissionId, index, error: String(error) }, 'Skipping keyframe');
    }
  }

  return paths;
};

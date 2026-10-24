// Client for the AI scoring service (AI_SERVICE_INTERFACE.md). The service only scores; policy and signing happen
// in the worker. MOCK_AI=true (ADR-018) uses the mock; otherwise the HTTP client calls AI_SERVICE_URL.
import type { WorkerConfig } from '../../config.js';
import type { AiScoreRequest, AiScoreResponse } from '../../generated/frozen/ai.js';
import { HttpAiClient } from './http-ai-client.js';
import { MockAiClient } from './mock-ai-client.js';

/** What the worker knows about the submission that the AI service reads for itself. Only the mock uses it. */
export type AiScoreContext = {
  /** The tag in the signed payload; the mock reads it back as tagDecoded (FR-145). */
  tag?: string | null;
};

export type AiClient = {
  score: (request: AiScoreRequest, context?: AiScoreContext) => Promise<AiScoreResponse>;
};

export type AiClientConfig = Pick<WorkerConfig, 'MOCK_AI' | 'AI_SERVICE_URL' | 'AI_SERVICE_TOKEN'>;

/** The mock when MOCK_AI is true, otherwise the HTTP client. */
export const createAiClient = (config: AiClientConfig): AiClient => {
  if (config.MOCK_AI) {
    return new MockAiClient();
  }

  if (!config.AI_SERVICE_URL || !config.AI_SERVICE_TOKEN) {
    throw new Error('AI_SERVICE_URL and AI_SERVICE_TOKEN are required when MOCK_AI is false');
  }

  return new HttpAiClient({ baseUrl: config.AI_SERVICE_URL, token: config.AI_SERVICE_TOKEN });
};

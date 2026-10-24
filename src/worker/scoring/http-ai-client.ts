import {
  aiScoreResponseSchema,
  type AiScoreRequest,
  type AiScoreResponse,
} from '../../generated/frozen/ai.js';
import { AiServiceError } from './ai-service-error.js';

export type HttpAiClientOptions = {
  baseUrl: string;
  token: string;
  /** Per-request timeout. The interface allows the service up to 60 seconds. */
  timeoutMs?: number;
  /** Retries after a 503 response. */
  maxRetries?: number;
  /** First backoff delay. Doubles on every retry. */
  backoffMs?: number;
  fetch?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
};

const DEFAULTS = { timeoutMs: 60_000, maxRetries: 3, backoffMs: 1_000 };
const HTTP = { busy: 503, serverError: 500 };
const ERROR_TEXT_CHARS = 500;

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });

/** Scores through AI_SERVICE_URL: 503 is retried with backoff, anything else that is not 2xx is an error. */
export class HttpAiClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(private readonly options: HttpAiClientOptions) {
    this.url = new URL('/v1/score', options.baseUrl).toString();
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
    this.backoffMs = options.backoffMs ?? DEFAULTS.backoffMs;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async score(request: AiScoreRequest): Promise<AiScoreResponse> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.post(request);

      if (response.status === HTTP.busy && attempt < this.maxRetries) {
        await response.body?.cancel();
        await this.sleep(this.backoffMs * 2 ** attempt);
        continue;
      }

      return this.read(response, request.submissionId);
    }
  }

  private async post(request: AiScoreRequest): Promise<Response> {
    try {
      return await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';

      throw new AiServiceError(
        null,
        timedOut
          ? `AI service timed out after ${this.timeoutMs} ms`
          : `AI service unreachable: ${String(error)}`,
        true,
      );
    }
  }

  private async read(response: Response, submissionId: string): Promise<AiScoreResponse> {
    if (!response.ok) {
      const text = await response.text().catch(() => '');

      throw new AiServiceError(
        response.status,
        `AI service returned ${response.status}: ${text.slice(0, ERROR_TEXT_CHARS)}`,
        response.status >= HTTP.serverError,
      );
    }

    const body: unknown = await response.json().catch(() => undefined);
    const parsed = aiScoreResponseSchema.safeParse(body);

    if (!parsed.success) {
      throw new AiServiceError(
        response.status,
        `AI service returned an invalid response: ${parsed.error.message}`,
        false,
      );
    }

    if (parsed.data.submissionId !== submissionId) {
      throw new AiServiceError(
        response.status,
        'AI service answered for a different submission',
        false,
      );
    }

    return parsed.data;
  }
}

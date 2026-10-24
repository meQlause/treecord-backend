/**
 * A failed scoring call. `status` is the HTTP status, or null when the service was unreachable or timed out.
 * `retryable` failures (503 after retries, other 5xx, network errors, timeouts) are retried by the job queue. The
 * rest are final: 422 means the video is unreadable, anything else fails the submission.
 */
export class AiServiceError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiServiceError';
  }
}

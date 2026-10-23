/** An instant given in epoch ms as ISO 8601 UTC (data-spec §8). Formats; never reads the clock. */
export const isoInstant = (epochMs: number): string => new Date(epochMs).toISOString();

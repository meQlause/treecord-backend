const MS_PER_SECOND = 1000;

const sorted = (map: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));

/** In-memory counters and gauges, served as JSON on GET /metrics. Reset on restart. */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  readonly startedAt = new Date();

  inc(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  set(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  get(name: string): number {
    return this.counters.get(name) ?? this.gauges.get(name) ?? 0;
  }

  snapshot(): {
    startedAt: string;
    uptimeSec: number;
    counters: Record<string, number>;
    gauges: Record<string, number>;
  } {
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeSec: Math.floor((Date.now() - this.startedAt.getTime()) / MS_PER_SECOND),
      counters: sorted(this.counters),
      gauges: sorted(this.gauges),
    };
  }
}

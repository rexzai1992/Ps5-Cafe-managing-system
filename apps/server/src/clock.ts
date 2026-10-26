export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class AdjustableClock implements Clock {
  public constructor(
    private offsetMs = 0,
    private readonly base: Clock = new SystemClock(),
  ) {}

  now(): number {
    return this.base.now() + this.offsetMs;
  }

  advance(durationMs: number): number {
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error("durationMs must be non-negative");
    this.offsetMs += durationMs;
    return this.offsetMs;
  }

  getOffset(): number {
    return this.offsetMs;
  }
}

export class FakeClock implements Clock {
  public constructor(private current: number) {}
  now(): number { return this.current; }
  advance(durationMs: number): void { this.current += durationMs; }
}


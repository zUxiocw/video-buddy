/** Non-blocking counter used to cap concurrent model calls. */
export class CountingSemaphore {
  private active = 0;

  constructor(private readonly limit: number) {}

  tryAcquire(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }

  get inUse(): number {
    return this.active;
  }

  get capacity(): number {
    return this.limit;
  }
}

import type { TrendItem } from '../types.js';

export interface TrendSource {
  /** Returns safe, current candidates. Implementations must never throw for network errors. */
  getTrends(): Promise<TrendItem[]>;
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TrendService } from '../trends/TrendService.js';
import { ApiError } from '../lib/errors.js';

const querySchema = z.object({
  q: z.string().max(2000).optional(),
});

export interface TrendsRouteDeps {
  trendService: TrendService;
}

export function registerTrendsRoute(app: FastifyInstance, deps: TrendsRouteDeps): void {
  app.get('/trends', async (request) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ApiError(422, 'VALIDATION_ERROR', '查询参数不合法');
    }
    const context = parsed.data.q ?? '';
    const candidates = await deps.trendService.getCandidates(context, [], { maxTrends: 10, maxSlang: 5 });
    return {
      trends: candidates.trends,
      slang: candidates.slang.map((entry) => ({
        term: entry.term,
        meaning: entry.meaning,
        tags: entry.tags,
      })),
    };
  });
}

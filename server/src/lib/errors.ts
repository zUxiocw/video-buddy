export interface ErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId?: string;
  };
}

export function errorBody(code: string, message: string, retryable: boolean, requestId?: string): ErrorBody {
  return { error: { code, message, retryable, ...(requestId ? { requestId } : {}) } };
}

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody(requestId?: string): ErrorBody {
    return errorBody(this.code, this.message, this.retryable, requestId);
  }
}

export class UpstreamError extends Error {
  constructor(
    readonly code: 'UPSTREAM_ERROR' | 'UPSTREAM_TIMEOUT' | 'UPSTREAM_PROTOCOL' | 'UPSTREAM_AUTH',
    message: string,
    readonly retryable = true,
    /** HTTP status when the upstream answered; lets callers distinguish 4xx causes. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export class Vita3kError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, retryable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = 'Vita3kError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof Vita3kError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: 'INTERNAL_ERROR', message, retryable: false } };
}

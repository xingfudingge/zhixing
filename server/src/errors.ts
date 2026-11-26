export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  badRequest: (message: string, details?: unknown) =>
    new ApiError(400, 'BAD_REQUEST', message, details),
  unauthorized: (message = '未授权', code = 'UNAUTHORIZED') =>
    new ApiError(401, code, message),
  forbidden: (message = '禁止访问', code = 'FORBIDDEN') =>
    new ApiError(403, code, message),
  notFound: (message = '资源不存在', code = 'NOT_FOUND') =>
    new ApiError(404, code, message),
  conflict: (message: string, code = 'CONFLICT', details?: unknown) =>
    new ApiError(409, code, message, details),
  tooManyRequests: (message: string, retryAfterSeconds: number) =>
    new ApiError(429, 'RATE_LIMITED', message, { retryAfterSeconds }),
  payloadTooLarge: (message: string) => new ApiError(413, 'PAYLOAD_TOO_LARGE', message),
  unprocessable: (message: string, code = 'UNPROCESSABLE', details?: unknown) =>
    new ApiError(422, code, message, details),
  serviceUnavailable: (message: string, code = 'SERVICE_UNAVAILABLE') =>
    new ApiError(503, code, message),
};

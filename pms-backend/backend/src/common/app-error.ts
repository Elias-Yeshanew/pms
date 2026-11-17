import { HttpException } from '@nestjs/common';

/** Business-rule error with a stable machine-readable code. */
export class AppError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
  static badRequest(code: string, message: string, details?: unknown) { return new AppError(400, code, message, details); }
  static unauthorized(code: string, message: string) { return new AppError(401, code, message); }
  static forbidden(code: string, message: string) { return new AppError(403, code, message); }
  static notFound(code: string, message: string) { return new AppError(404, code, message); }
  static conflict(code: string, message: string, details?: unknown) { return new AppError(409, code, message, details); }
  static locked(code: string, message: string, details?: unknown) { return new AppError(423, code, message, details); }
}

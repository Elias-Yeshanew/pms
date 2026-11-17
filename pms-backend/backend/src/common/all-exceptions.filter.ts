import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { RequestContextStore } from './request-context';
import { AppError } from './app-error';

const PG_CODES: Record<string, { status: number; code: string; message: string }> = {
  '23505': { status: 409, code: 'DUPLICATE_VALUE', message: 'A record with the same unique value already exists.' },
  '23503': { status: 409, code: 'REFERENCE_VIOLATION', message: 'The record is referenced by, or refers to, a record that does not allow this change.' },
  '23514': { status: 400, code: 'CONSTRAINT_VIOLATION', message: 'The data violates a validation rule.' },
  '23P01': { status: 409, code: 'OVERLAPPING_PERIOD', message: 'The record overlaps an existing one for the same period.' },
  '40P01': { status: 409, code: 'CONCURRENT_UPDATE', message: 'Another change was happening at the same time. Please try again.' },
  '40001': { status: 409, code: 'CONCURRENT_UPDATE', message: 'Another change was happening at the same time. Please try again.' },
  '23502': { status: 400, code: 'MISSING_VALUE', message: 'A required value is missing.' },
  '22P02': { status: 400, code: 'INVALID_FORMAT', message: 'A value has an invalid format.' },
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = RequestContextStore.get()?.requestId;
    let status = 500;
    let body: Record<string, unknown> = { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' };

    if (exception instanceof AppError) {
      status = exception.getStatus();
      body = { code: exception.code, message: exception.message, ...(exception.details !== undefined ? { details: exception.details } : {}) };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse() as any;
      const messages = Array.isArray(r?.message) ? r.message : undefined;
      body = {
        code: status === 400 ? 'VALIDATION_ERROR' : status === 429 ? 'TOO_MANY_REQUESTS' : status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR',
        message: messages ? 'The request contains invalid data.' : (typeof r === 'string' ? r : r?.message ?? exception.message),
        ...(messages ? { details: messages } : {}),
      };
    } else if (typeof (exception as any)?.code === 'string' && PG_CODES[(exception as any).code]) {
      const m = PG_CODES[(exception as any).code];
      status = m.status;
      body = { code: m.code, message: m.message };
      if ((exception as any).code !== '23505') this.logger.warn(`${(exception as any).code}: ${(exception as Error).message}`);
    } else if ((exception as any)?.code === 'P0001' || (exception as any)?.code === '23000') {
      status = 409;
      body = { code: 'RULE_VIOLATION', message: 'The operation is not allowed by a data integrity rule.' };
    } else {
      this.logger.error(`Unhandled error [${requestId}]`, (exception as Error)?.stack ?? String(exception));
    }

    res.status(status).json({ statusCode: status, ...body, requestId });
  }
}

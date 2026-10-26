import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from '../../types/index.js';
import { ShortyError } from '../shared/errors.js';

export { ShortyError, ERROR_STATUS } from '../shared/errors.js';

/** A route handler before it has been wrapped. May reject; `wrap` catches. */
export type RawHandler = (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>;

/**
 * Every admin route answers JSON, including on failure (traps #6):
 * `ShortyError` → its status + `{ error: code, ...details }`; anything else →
 * logged, 500 `{ error: 'internal_error' }`.
 */
export function wrap(logger: Logger, handler: RawHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      if (res.headersSent) return next(err);
      if (err instanceof ShortyError) {
        return res.status(err.status).json({ error: err.code, ...(err.details ?? {}) });
      }
      logger.error?.({ err, path: req.originalUrl }, 'shorty: request failed');
      res.status(500).json({ error: 'internal_error' });
    }
  };
}

/** Placeholder for contract stubs. Every one of these is a red test until its PR lands. */
export function notImplemented(what: string): never {
  throw new Error(`shorty: ${what} is not implemented yet`);
}

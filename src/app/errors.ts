import type { AppErrorCode } from '../domain/types';

export class AppError extends Error {
  public override readonly name = 'AppError';

  public constructor(
    public readonly code: AppErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

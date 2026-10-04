/**
 * Deadlines for every network call the plugin makes, so Hive or Cognito being
 * slow fails predictably instead of hanging Homebridge startup, a poll, or a
 * command.
 */

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Raised when a call does not settle within its deadline. */
export class HiveTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`${what} timed out after ${timeoutMs / 1000}s.`);
    this.name = 'HiveTimeoutError';
  }
}

/** `fetch`, aborted if the response — body included — takes too long. */
export function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Reject if `promise` has not settled within `timeoutMs`.
 *
 * For calls whose transport this plugin does not own — amazon-cognito-identity-js
 * makes its own requests with no deadline, so a stalled token refresh would
 * otherwise hold a poll open for as long as the runtime's socket defaults allow.
 * The underlying call is not cancelled; its eventual result is just ignored.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  what: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HiveTimeoutError(what, timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

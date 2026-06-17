import fetch, { RequestInfo, RequestInit, Response } from 'node-fetch';

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * node-fetch v2 supports a timeout option. Keeping this in one helper makes
 * Hive network calls fail predictably instead of hanging Homebridge startup or
 * command handling indefinitely.
 */
export function fetchWithTimeout(
  url: RequestInfo,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, {
    ...init,
    timeout: timeoutMs,
  } as RequestInit & { timeout: number });
}


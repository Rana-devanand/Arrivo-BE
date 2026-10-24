/**
 * Server log lines. Quiet while tests run.
 *
 * Never put coordinates, addresses, place names, phone numbers, emails or push
 * tokens in a message: these logs end up in the hosting dashboard. Ids, counts
 * and error codes are fine.
 */
const quiet = () => process.env.NODE_ENV === 'test';

export function logInfo(message: string): void {
  if (!quiet()) console.log(message);
}

export function logError(message: string): void {
  if (!quiet()) console.error(message);
}

/** The error's code if it has one (Firebase errors do), else its message. */
export function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string') return e.code;
  return e instanceof Error ? e.message : 'unknown error';
}

/**
 * Errors raised across module boundaries.
 *
 * These live here rather than beside the code that raises them because their
 * producer and consumer are different modules: putting them in either one
 * would make the other import it for a single class, and `platform.ts` and
 * `matterPlatform.ts` already depend on each other's direction of travel.
 */

/**
 * Raised when a command arrives before Hive authentication has finished.
 *
 * Cached Matter endpoints stay live across a restart and can accept a command
 * within milliseconds of boot, long before the Cognito round-trip completes.
 * Raised by the platform's `hive` getter; the Matter layer maps it to an
 * InvalidInState status so the controller is told the device is not ready yet,
 * rather than that the command failed.
 */
export class HiveNotReadyError extends Error {
  constructor() {
    super('Hive is not authenticated yet — command ignored.');
    this.name = 'HiveNotReadyError';
  }
}

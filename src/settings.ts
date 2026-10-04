/**
 * Shared constants for the Hive Thermostat platform.
 */

/** Must match the "name" in package.json */
export const PLUGIN_NAME = 'homebridge-hive-thermostat';

/** Must match the "pluginAlias" in config.schema.json */
export const PLATFORM_NAME = 'HiveThermostat';

/** Hive backend URLs */
export const HIVE_URLS = {
  /** Page whose first <script> tag holds the Cognito pool + client IDs */
  sso: 'https://sso.hivehome.com/',
  /** Beekeeper base — handles both reads and writes for most accounts. */
  beekeeperBase: 'https://beekeeper.hivehome.com/1.0',
  /** Regional write host, kept only as a fallback for accounts that need it. */
  beekeeperWriteBase: 'https://beekeeper-uk.hivehome.com/1.0',
  /** All nodes (products + devices + actions) */
  nodesAll: 'https://beekeeper.hivehome.com/1.0/nodes/all?products=true&devices=true&actions=true',
} as const;

/** Hive's edge rejects requests without a normal browser User-Agent. */
export const HIVE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** How often (ms) to poll Hive for state. Hive is cloud-polled; keep this gentle. */
export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** Minimum allowed poll interval to avoid hammering the API. */
export const MIN_POLL_INTERVAL_MS = 15_000;

/**
 * Consecutive failed polls before every accessory is reported as unreachable,
 * rather than left showing the last values Hive sent as though they were live.
 */
export const STALE_AFTER_FAILED_POLLS = 3;

/**
 * Backoff for retrying sign-in when Hive could not be reached at startup —
 * typically a power cut, where Homebridge comes up before the router does.
 */
export const STARTUP_RETRY_MIN_MS = 30_000;
export const STARTUP_RETRY_MAX_MS = 30 * 60_000;

/** Hive thermostat temperature bounds (Celsius). */
export const HIVE_MIN_TEMP = 5;
export const HIVE_MAX_TEMP = 32;
export const HIVE_TEMP_STEP = 0.5;

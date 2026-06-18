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

/** How often (ms) to poll Hive for state. Hive is cloud-polled; keep this gentle. */
export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** Minimum allowed poll interval to avoid hammering the API. */
export const MIN_POLL_INTERVAL_MS = 15_000;

/** Hive thermostat temperature bounds (Celsius). */
export const HIVE_MIN_TEMP = 5;
export const HIVE_MAX_TEMP = 32;
export const HIVE_TEMP_STEP = 0.5;

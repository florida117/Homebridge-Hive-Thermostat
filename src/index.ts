import { API } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { HiveThermostatPlatform } from './platform';

export = (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, HiveThermostatPlatform);
};

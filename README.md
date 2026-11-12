<p align="center">
  <img src="https://raw.githubusercontent.com/florida117/Homebridge-Hive-Thermostat/main/branding/hive_logo.png" width="120" alt="Hive logo">
</p>

# homebridge-hive-thermostat

[![verified-by-homebridge](https://img.shields.io/badge/_-verified-blueviolet?color=%23491F59&style=flat&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

A Homebridge plugin that exposes **Hive heating zones, radiator valves and hot water** — and Hive plugs, lights and sensors — to Apple HomeKit, talking directly to the Hive cloud API.

It was written as a modern replacement for older Hive plugins that broke when Hive moved to AWS Cognito authentication with mandatory SMS two-factor auth. Authentication, token refresh, and the 2FA handshake are all handled here.

## Why this exists

Hive's own HomeKit bridge has long-standing stability problems — accessories can drop to **"No Response"** after a short period even on a wired, healthy network, because the hub silently stops advertising its HomeKit (HAP/mDNS) service. This plugin sidesteps that entirely by polling the Hive cloud and re-presenting the devices through Homebridge, where *you* control the HomeKit advertisement.

> **Note:** because it uses the Hive cloud API, this plugin requires an internet connection to function. It does not talk to the Hive hub locally.

## HomeKit (HAP) or Matter?

You can use either, or both at once:

- **HomeKit / HAP** works on any Homebridge install with no extra setup — your
  Hive devices appear in the Home app through the Homebridge bridge. This is the
  default and the right choice for most people.
- **Matter** is optional and needs Homebridge v2 with Matter enabled (see
  [Matter support](#matter-support)). It additionally publishes the same Hive
  devices over Matter, which is useful if you want to add them to a
  Matter/Thread ecosystem or controller. Turn it off with `enableMatter: false`
  if you only want HAP.

Both expose the same devices with the same behavior, so pick whichever your
setup prefers.

## Features

- Auto-discovers all heating zones, radiator valves and hot water controls on your account
- Each heating zone exposed as a HomeKit **Thermostat** (current temp, target temp, off / heat / schedule)
- Each room of Hive **radiator valves** (TRVs) exposed as its own **Thermostat**, with the same controls plus a **battery level** and low-battery warning
- Hot water exposed as a **Switch** with a timed boost (like homebridge-nest): flip it on to run hot water for a configurable number of minutes, flip it off to cancel
- Hive **plugs, lights and sensors** too (see [Other Hive devices](#other-hive-devices)) — on automatically, and each kind can be turned off
- Optional Homebridge v2 **Matter** support: heating zones and radiator valves are also exposed as Matter Thermostats and hot water boosts as Matter On/Off Outlets
- Reports **No Response** in the Home app when Hive marks a device offline, or when Hive itself stops answering, rather than showing stale data (Matter controllers see the device as unreachable)
- One-time SMS 2FA during setup, then silent token refresh — no repeated SMS prompts
- Keeps retrying sign-in if Homebridge starts before your network does (after a power cut, say), instead of waiting for a restart
- Configurable poll interval

## Mode mapping

### HomeKit

| Hive mode | HomeKit state |
|-----------|---------------|
| Off       | Off           |
| Manual    | Heat          |
| Schedule  | Auto          |

During a boost started from the Hive app, the zone shows the mode it will
return to when the boost ends.

Radiator valves use the same mapping: each valve room has its own mode,
target and schedule in Hive, separate from the heating zone it sits in.

Changing the temperature while a zone is in **Auto** keeps it on its schedule:
Hive treats the new temperature as an override until the next scheduled
change. In any other mode, changing the temperature switches the zone to
**Heat** (manual) at that temperature.

### Matter

| Hive mode | Matter thermostat system mode |
|-----------|--------------------------------|
| Off       | Off                            |
| Manual    | Heat                           |
| Schedule  | Auto                           |

As with HomeKit, a boost shows the mode the zone will return to, and a
temperature change in Auto is a temporary override.

> The Matter thermostat also shows a **Cool** button. Matter only offers an
> **Auto** mode when the Cooling feature is present, so Cooling is advertised to
> keep Auto (and therefore the Hive schedule) available — but Hive cannot cool,
> so selecting Cool is rejected and has no effect.

Matter thermostat temperatures are exposed in Celsius. Hot water is exposed as
an On/Off Outlet whose on state represents a manual boost, matching the HomeKit
switch behavior.

## Other Hive devices

Hive's other devices are supported from the shapes Hive's API uses for them,
but **have not been tested on real hardware yet**. If you have one, please
report how it behaves in a GitHub issue — a debug log (Homebridge debug mode)
helps most.

| Hive device | HomeKit | Matter |
|-------------|---------|--------|
| Active Plug | Outlet (on/off, in use) | On/Off Outlet |
| Warm white (dimmable) bulb | Lightbulb (on/off, brightness) | Dimmable Light |
| Cool to warm white (tuneable) bulb | Lightbulb with colour temperature | Color Temperature Light |
| Colour bulb | Lightbulb with colour temperature and colour | Extended Color Light |
| Motion sensor | Motion Sensor, with battery | Occupancy Sensor |
| Door/window sensor | Contact Sensor, with battery | Contact Sensor |

- They appear automatically. To hide a kind, turn off **Show Hive Plugs**,
  **Show Hive Lights** or **Show Hive Sensors** (`enablePlugs`,
  `enableLights`, `enableSensors`); its accessories are then removed.
- Hive bulbs dim in 5% steps, so a brightness is rounded to the nearest 5%.
- Sensors are read from the Hive cloud at the poll interval, so motion and
  door changes can take that long to show. They are not suited to fast
  automations such as lights on at motion.
- Battery level is shown over HomeKit only.

## Installation

Install through the Homebridge UI (search for "Hive Thermostat") or:

```bash
npm install -g homebridge-hive-thermostat
```

## Configuration

Use the Homebridge UI settings form, or add a platform block to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "HiveThermostat",
      "name": "Hive Thermostat",
      "username": "you@example.com",
      "password": "your-hive-password",
      "pollInterval": 30,
      "hotWaterDurationMinutes": 30,
      "enableMatter": true
    }
  ]
}
```

### First-time setup with two-factor authentication

1. Enter your **username** and **password**, save, and restart Homebridge.
2. If your account has SMS 2FA, the log will prompt:
   *"Hive requires two-factor authentication…"* and a code will be texted to you.
3. Put that code in the **2FA Code** (`smsCode`) field and click **Save**.
   **Don't restart** — the plugin picks the code up from the config within a few
   seconds. Codes expire after a few minutes, so enter it promptly.
4. Once it logs *"2FA accepted"*, you can clear the 2FA Code field. The refresh
   token is stored so future restarts don't need it.

Each code works only for the sign-in attempt that sent it. If you restart
before entering the code, the plugin carries on waiting for that same code
rather than sending a new one. If a code has expired, entering it makes the
plugin send a fresh one; enter that one instead.

If the refresh token is ever rejected (Hive occasionally invalidates them
server-side), you'll see a re-authentication message in the log and need to
repeat the SMS step once.

### Matter support

Matter support requires Homebridge v2 with Matter enabled for the main bridge or
the plugin's child bridge. The plugin will continue to expose normal HomeKit
accessories, and when both Homebridge Matter and `enableMatter` are enabled it
will additionally register Matter accessories.

To use it:

1. Run Homebridge v2 on a supported Node.js version. **Homebridge 2.4.0 or
   later is recommended** — it lets a plugin choose its own Matter cluster
   features, which is how this plugin pins the thermostat to heating-only
   behaviour. Older 2.x releases are still supported.
2. Enable Matter in the relevant Homebridge bridge settings.
3. Keep **Enable Matter Accessories** (`enableMatter`) turned on in this plugin.
4. Restart Homebridge so the Matter bridge can register the Hive accessories.

Matter support is intentionally limited to the device types that map cleanly to
Hive:

- Heating zones and radiator valve rooms become Matter Thermostats. Battery
  level is shown over HomeKit only.
- Hot water becomes a Matter On/Off Outlet for manual boost control.
- Plugs, lights and sensors become the Matter devices listed under
  [Other Hive devices](#other-hive-devices).
- Hive schedules are not edited through Matter; Schedule maps to Matter Auto.

## Credits

The Cognito authentication approach is informed by the excellent
[`pyhiveapi`](https://github.com/Pyhass/Pyhive) project, which powers the
Home Assistant Hive integration.

## Disclaimer

This is an unofficial plugin and is not affiliated with or endorsed by Hive or
Centrica. Use at your own risk.

## License

MIT

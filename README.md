<p align="center">
  <img src="https://raw.githubusercontent.com/florida117/Homebridge-Hive-Thermostat/main/branding/hive_logo.png" width="120" alt="Hive logo">
</p>

# homebridge-hive-thermostat

A Homebridge plugin that exposes **Hive heating zones and hot water** to Apple HomeKit, talking directly to the Hive cloud API.

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

- Auto-discovers all heating zones and hot water controls on your account
- Each heating zone exposed as a HomeKit **Thermostat** (current temp, target temp, off / heat / schedule)
- Hot water exposed as a **Switch** with a timed boost (like homebridge-nest): flip it on to run hot water for a configurable number of minutes, flip it off to cancel
- Optional Homebridge v2 **Matter** support: heating zones are also exposed as Matter Thermostats and hot water boosts as Matter On/Off Outlets
- Reports **No Response** in the Home app when Hive marks a device offline, rather than showing stale data
- One-time SMS 2FA during setup, then silent token refresh — no repeated SMS prompts
- Configurable poll interval

## Mode mapping

### HomeKit

| Hive mode | HomeKit state |
|-----------|---------------|
| Off       | Off           |
| Manual    | Heat          |
| Schedule  | Auto          |

### Matter

| Hive mode      | Matter thermostat system mode |
|----------------|--------------------------------|
| Off            | Off                            |
| Manual / Boost | Heat                           |
| Schedule       | Auto                           |

> The Matter thermostat also shows a **Cool** button. Matter only offers an
> **Auto** mode when the Cooling feature is present, so Cooling is advertised to
> keep Auto (and therefore the Hive schedule) available — but Hive cannot cool,
> so selecting Cool is rejected and has no effect.

Matter thermostat temperatures are exposed in Celsius. Hot water is exposed as
an On/Off Outlet whose on state represents a manual boost, matching the HomeKit
switch behavior.

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
   *"Hive requires SMS two-factor authentication…"* and a code will be texted to you.
3. Put that code in the **2FA Code** (`smsCode`) field, save, and restart again.
4. Once it logs *"2FA accepted"*, you can clear the 2FA Code field. The refresh
   token is stored so future restarts don't need it.

If the refresh token is ever rejected (Hive occasionally invalidates them
server-side), you'll see a re-authentication message in the log and need to
repeat the SMS step once.

### Matter support

Matter support requires Homebridge v2 with Matter enabled for the main bridge or
the plugin's child bridge. The plugin will continue to expose normal HomeKit
accessories, and when both Homebridge Matter and `enableMatter` are enabled it
will additionally register Matter accessories.

To use it:

1. Run Homebridge v2 on a supported Node.js version.
2. Enable Matter in the relevant Homebridge bridge settings.
3. Keep **Enable Matter Accessories** (`enableMatter`) turned on in this plugin.
4. Restart Homebridge so the Matter bridge can register the Hive accessories.

Matter support is intentionally limited to the device types that map cleanly to
Hive:

- Heating zones become Matter Thermostats.
- Hot water becomes a Matter On/Off Outlet for manual boost control.
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

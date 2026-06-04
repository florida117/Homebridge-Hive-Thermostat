# homebridge-hive-thermostat

A Homebridge plugin that exposes **Hive heating zones and hot water** to Apple HomeKit, talking directly to the Hive cloud API.

It was written as a modern replacement for older Hive plugins that broke when Hive moved to AWS Cognito authentication with mandatory SMS two-factor auth. Authentication, token refresh, and the 2FA handshake are all handled here.

## Why this exists

Hive's own HomeKit bridge has long-standing stability problems — accessories can drop to **"No Response"** after a short period even on a wired, healthy network, because the hub silently stops advertising its HomeKit (HAP/mDNS) service. This plugin sidesteps that entirely by polling the Hive cloud and re-presenting the devices through Homebridge, where *you* control the HomeKit advertisement.

> **Note:** because it uses the Hive cloud API, this plugin requires an internet connection to function. It does not talk to the Hive hub locally.

## Features

- Auto-discovers all heating zones and hot water controls on your account
- Each heating zone exposed as a HomeKit **Thermostat** (current temp, target temp, off / heat / schedule)
- Hot water exposed as a **Switch** with a timed boost (like homebridge-nest): flip it on to run hot water for a configurable number of minutes, flip it off to cancel
- Reports **No Response** in the Home app when Hive marks a device offline, rather than showing stale data
- One-time SMS 2FA during setup, then silent token refresh — no repeated SMS prompts
- Configurable poll interval

## Mode mapping

| Hive mode | HomeKit state |
|-----------|---------------|
| Off       | Off           |
| Manual    | Heat          |
| Schedule  | Auto          |

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
      "hotWaterDurationMinutes": 30
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

## Credits

The Cognito authentication approach is informed by the excellent
[`pyhiveapi`](https://github.com/Pyhass/Pyhive) project, which powers the
Home Assistant Hive integration.

## Disclaimer

This is an unofficial plugin and is not affiliated with or endorsed by Hive or
Centrica. Use at your own risk.

## License

MIT

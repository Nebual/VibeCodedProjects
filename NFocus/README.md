# NFocus — TV Gaming Mode

One button to move from desk to couch, and one to come back.

**On:** the TV becomes the sole display · Bluetooth off · Windows notifications suppressed · Discord muted locally.
**Off:** everything goes back to exactly how it was.

Built for Windows PowerShell 5.1 on Windows 11 25H2. No third-party modules, no downloads.

---

## Setup

Run these once, in order.

**1. Learn which display is the TV** — the TV must be connected and switched on.

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .\Register-NFocusTv.ps1
```

It auto-detects the only connected HDMI display, shows you what it found, and saves the TV's EDID hardware id. Use `-List` to see candidates, `-HardwareId TCL9653` to pick explicitly.

**2. Pin the desk Bluetooth adapter** — with the desk adapter switched on.

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .\Register-NFocusBluetooth.ps1 -List
```

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .\Register-NFocusBluetooth.ps1 -InstanceId "USB\VID_0489&PID_E10A\8&5D1DE9F&0&15"
```

**This step is not optional if you have more than one radio.** There are two here — the desk adapter and the TV room's — and which ones report `Present` *changes depending on what is powered up*: disabling the desk adapter makes a second radio appear. Auto-detection picked the wrong one during testing and silently skipped re-enabling the desk adapter. Pinning by instance id makes it exact. A disabled adapter still reports `Present`, so the pin keeps working across cycles.

**3. Register the elevated Bluetooth tasks** — one UAC prompt, ever.

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-NFocus.ps1
```

Skip this and everything still works, but each toggle raises its own UAC prompt — and you have to be at the keyboard to answer it, which rather defeats a couch-gaming button.

**4. Bind `Launch\Disable.vbs` to a physical button before your first real run.** If the TV is dark, that is how you get your desk monitors back without being able to see anything.

---

## Use

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .\Enable-TvGamingMode.ps1
```

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .\Disable-TvGamingMode.ps1
```

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .\Get-TvGamingModeStatus.ps1
```

For Stream Deck, hotkeys, or Steam, point at `Launch\Enable.vbs` / `Launch\Disable.vbs` instead — those never flash a console window. (`-WindowStyle Hidden` still flashes one; the host is created and only then hidden.)

### Useful switches

| Switch | Effect |
|---|---|
| `-DryRun` | Run the whole path, change nothing. Capture and preflight are read-only so they run for real. |
| `-Only display,bluetooth` | Just those steps. Also accepted as one comma-joined string, which is how `-File` passes it. |
| `-ConfirmTimeout 40` | Display deadman, in seconds. `0` disables it. |
| `-Force` | On Enable: reconcile-revert, then enable fresh. On Disable: restore everything unconditionally. |
| `-Quiet` | No console output. Used by the `.vbs` launchers. |

`-Force` on Enable deliberately does **not** mean "overwrite the state file" — that would turn the escape hatch into the very footgun this design exists to prevent.

### Exit codes

`0` ok · `1` error · `2` already in that state · `3` no state file, best-effort reset · `4` corrupt state, archived · `5` refused, machine already looks enabled · `6` TV not connected · `10` partial · `11` another instance running

`Get-TvGamingModeStatus.ps1` returns `0` inactive · `2` active · `4` corrupt · `10` partial/drifted · `12` stale, so a Stream Deck button can reflect the real state.

---

## What actually happens, and what doesn't

### Display — works

Uses the CCD API (`QueryDisplayConfig` / `SetDisplayConfig`). The previous layout is saved as the exact path/mode arrays and replayed verbatim on the way back.

The TV is identified by its **EDID hardware id** (`TCL9653`). Nothing else here is stable: this machine's TV and its ASUS monitor share a physical port and therefore the same target UID, adapter LUIDs are regenerated every boot, and `\\.\DISPLAY2` was the ASUS in one probe and the TV in the next. Saved LUIDs are re-resolved against stable adapter device paths before every restore.

A **deadman** is armed before the switch (40s default) and disarmed once the switch is verified. It catches "the apply silently didn't take". It cannot detect "the TV is powered off" — a dark TV behind a live HDMI link reports as active, so the two are indistinguishable through this API. That is what the physical Disable button and the failure beep are for.

### Bluetooth — works

Disables the **pinned desk adapter** via `Disable-PnpDevice`, through a pre-registered elevated scheduled task so there is no UAC prompt per toggle. With the desk adapter down, the TV room's adapter takes over.

**Disable turns Bluetooth back on unconditionally** when NFocus turned it off. This is a deliberate exception to the tool's general restore-what-was-there rule, because that is the behaviour asked for. If Bluetooth was *already* off when you enabled the mode, Disable leaves it off.

Two things that bit during development, both worth knowing if you read the code:

- A disabled PnP device reports `Status='Error'` with `Problem=22`, **not** `Status='Disabled'`. Keying off the status string silently mis-detects, so the problem code is what's checked.
- The set of `Present` radios is **not stable**. Four of five were phantoms with the desk adapter enabled; disabling it made a previously-absent radio appear, and auto-detection then picked that one and skipped re-enabling the desk adapter. Hence the pin — see setup step 2.

### Discord — partial, by design and by circumstance

Discord's **online status is deliberately not touched**. There is no sanctioned way to set it: bots cannot change a user's presence and OAuth2 has no scope for it. The only method that works is a user token against `PATCH /users/@me/settings`, which is self-botting — a ToS violation carrying account-termination risk. Your friends will still see you as Online.

Instead, Discord's audio sessions are muted via Core Audio.

**Measured limitation:** Discord creates an audio session *lazily*. With six Discord processes running and nothing playing, it holds no audio session at all — so there may be nothing to mute at enable time, and a session created afterwards (joining a call) will not be muted. `Get-TvGamingModeStatus.ps1` reports this honestly rather than claiming success. Re-running Enable re-asserts the mute.

### Notifications — see the caveat

Two layers are attempted:

1. `Windows.UI.Shell.FocusSessionManager` — the real Windows 11 Do Not Disturb.
2. The `ToastEnabled` and `NOC_GLOBAL_SETTING_TOASTS_ENABLED` registry switches.

**On this build (25H2, 26200) neither could be made to work.** Measured, not assumed:

- `TryStartFocusSession()` fails with *"Access is denied. Feature com.microsoft.windows.focussessionmanager.1 is not available"*. The read side (`IsSupported`, `IsFocusActive`) works fine unelevated; the **write** side is gated to callers with package identity, which a plain script does not have.
- Setting `ToastEnabled=0` and `NOC_GLOBAL_SETTING_TOASTS_ENABLED=0` did not change what the notification platform reports, checked from a **fresh process**. Per-app `Enabled=0` had no effect either.
- Restarting `WpnUserService` to force a cache re-read — which does succeed unelevated — **also** made no difference. So these values look simply legacy on 25H2, not merely cached.

The registry layer is still applied and still reverted faithfully (including deleting the value that should be absent), so it costs nothing and is correct if Microsoft ever honours it again. But **treat this step as unverified** until you have watched for a real toast with the mode on.

Deliberately **not** shipped: the undocumented WNF and CloudStore quiet-hours pokes. The CloudStore blob is real and findable (the profile string is even a same-length swap, `Unrestricted` → `PriorityOnly`), but the shell almost certainly won't notice it without an equally undocumented WNF publish, and this tool should not write state it cannot verify.

If you want DND during games regardless, Windows 11 has a built-in automatic rule for it: **Settings → System → Notifications → Turn on do not disturb automatically → When playing a game.** That is supported, survives updates, and needs no script.

---

## How revert works

> Restore the recorded prior value, but only where we actually changed it, and only if the current value still matches what we applied.

A compare-and-swap. Three cases:

- **We never changed it** → never touched. Bluetooth is the live case.
- **We changed it and it still matches** → restore the prior value, honouring *absent* as a **delete**.
- **We changed it and it no longer matches** → you changed it by hand while the mode was on. Your more recent action wins; NFocus leaves it and says so.

Every captured value is a tri-state `{present, kind, data}`, never a bare boolean. This machine is why: `ToastEnabled` is present=1 while `NOC_GLOBAL_SETTING_TOASTS_ENABLED` is absent, so one restores by writing and the other by deleting. "Restore the default" would silently create a value that should not exist.

### Not stranding you

Enabling twice must never record the already-modified machine as the baseline — that would make revert impossible for good. Five independent layers prevent it:

1. The state file's existence is the flag; an active state file is never recaptured.
2. A cross-process mutex with a zero timeout, because a Stream Deck double-tap is two processes 200 ms apart and both would otherwise pass layer 1.
3. The first write uses `CreateNew`, so it can never overwrite.
4. A world-check: if the machine already *looks* enabled (2 of 3 signals) with no state file, Enable refuses. This is the only layer that catches "state file deleted while active".
5. `state.json.bak`, free from the atomic replace.

A reboot while the mode is on is detected via the boot timestamp. Steps survive a reboot unevenly — registry and Bluetooth persist, the Discord mute does not — so a stale state file switches both entry points into reconcile mode: re-measure per step, act only on the delta, never blind-write.

---

## Layout

```
Enable-TvGamingMode.ps1     Disable-TvGamingMode.ps1
Get-TvGamingModeStatus.ps1  Register-NFocusTv.ps1
Install-NFocus.ps1          Set-NFocusBluetooth.ps1   (elevated helper, not for direct use)
Launch\                     Enable.vbs  Disable.vbs
NFocus\                     the module
  Private\                  steps, state, logging, C# interop
  Public\                   the entry points
State\                      config.json, state.json, logs\, archive\   (git-ignored)
Tools\                      NFocus.Interop.dll  (built on first run, ~19 KB)
```

`State\` is machine-specific — PnP instance ids, adapter LUIDs, audio endpoint GUIDs. Don't sync it to another PC.

Logs are in `State\logs\nfocus.log`, rotated at 1 MB. Every run logs its captured baseline as compact JSON, which is what lets a lost state file be reconstructed by hand.

## Recovery

Stuck on the TV with no picture? Press the button bound to `Launch\Disable.vbs`. Failing that, **Win+P → Extend**, then run Disable normally.

Two beeps means on, one means off, a low buzz means something failed.

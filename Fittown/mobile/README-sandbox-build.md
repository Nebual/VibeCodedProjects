# Building this in a sandbox (no Android Studio, no device)

Notes from getting `./gradlew assembleDebug` to succeed in an environment
with no Android Studio, no emulator, and no physical phone — kept because
none of this is discoverable from the usual Capacitor docs, which all assume
Android Studio.

## What this proves, and what it doesn't

A successful `assembleDebug` proves the Kotlin, the manifest, and the Gradle
config are all correct enough to produce a real APK — confirmed here by
inspecting the built APK directly (`aapt dump xmltree` for the manifest,
`dexdump` for `DeviceTokenPlugin`'s classes) rather than trusting a clean
Gradle exit code alone.

It proves nothing about whether the app actually **runs**: no emulator (no
`/dev/kvm` in this sandbox) and no physical device means the WebView loading
`server.url`, the `fittown://pair` deep link actually firing, the
`DeviceTokenPlugin` round-tripping through the real Capacitor bridge, and
`EncryptedSharedPreferences` behaving as expected are all unverified. Test
those on real hardware before trusting them.

## Requirements this environment didn't have by default

- **`maven.google.com` reachable.** Hosts every AndroidX/Gradle-plugin
  artifact; nothing Android compiles without it. If a sandbox's network
  policy blocks it (`403` with `blocked by default deny policy`, not an org
  policy), the fix is `sbx policy allow network maven.google.com` on the
  host. `dl.google.com`, `storage.googleapis.com`, `repo.maven.apache.org`
  and `plugins.gradle.org` were already open here.
- **A JDK old enough for Gradle 8.11.1** (the version Capacitor's wrapper
  pins). This sandbox's default JDK was 25, which Gradle 8.11.1 can't read
  (`Unsupported class file major version 69`). Installed JDK 21 alongside it
  (`sudo apt-get install openjdk-21-jdk-headless`) and pointed Gradle at it
  via `org.gradle.java.home` in `android/gradle.properties` — see that file's
  comment; a normal workstation likely already defaults to a compatible JDK
  and can drop the line.
- **The Android SDK itself** — nothing here assumes Android Studio, only the
  command-line tools:
  ```bash
  mkdir -p ~/android-sdk/cmdline-tools
  cd ~/android-sdk/cmdline-tools
  curl -sS -o cmdline-tools.zip \
    https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  unzip -q cmdline-tools.zip && mv cmdline-tools latest && rm cmdline-tools.zip

  export ANDROID_HOME="$HOME/android-sdk"
  yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --licenses
  "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" \
    "platform-tools" "platforms;android-35" "build-tools;35.0.0"
  echo "sdk.dir=$ANDROID_HOME" > android/local.properties   # gitignored, machine-specific
  ```
- **TypeScript pinned to the 5.x line** in `mobile/`. `npm install -D
  typescript` picked up TypeScript 7 (the native/Go rewrite) by default here,
  and Capacitor CLI 7.6.8's `capacitor.config.ts` loader isn't built against
  its API shape (`Cannot read properties of undefined (reading 'CommonJS')`).
  `npm install -D typescript@^5` fixed it. Worth checking again later —
  this is very plausibly fixed in a newer `@capacitor/cli`.

## Then it's the ordinary Capacitor workflow

```bash
cd mobile
npm install
FITTOWN_SERVER_URL=https://your-fittown-host npx cap sync android
cd android
./gradlew assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

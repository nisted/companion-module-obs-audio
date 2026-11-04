# companion-module-obs-audio

A Bitfocus Companion module that turns OBS Studio's audio into a desk: auto level and calibrate per input, Intech Grid faders with pickup (catch / latch / override / release), OBS's processing filters, recording tracks, and a fader and meter web page (also an OBS dock).

See [companion/HELP.md](companion/HELP.md) for how to use it.

## Building

Every push builds the module package on GitHub (Actions tab → latest run → `companion-module-obs-audio` artifact). Import the `.tgz` in Companion with **Modules → Import module package**.

The shared engine lives in a git submodule at `core/` ([nisted/rebel-audio-core](https://github.com/nisted/rebel-audio-core)), so clone with `git clone --recursive` (or run `git submodule update --init` after cloning).

Locally: `corepack enable`, `yarn install`, `yarn package`. Tests (the core's, plus these against a pretend OBS): `yarn test`.

## Layout

- `core/` (submodule): the generic engine, auto level, pickup, gestures, settings store, features, web server and the page. See `core/src/device.ts` for the Device interface.
- `src/obs-device.ts`: OBS as a core Device (inputs, filters, monitoring types, tracks, recording).
- `src/obs.ts`: a small obs-websocket v5 client (Node's built-in WebSocket).
- `src/obs-filters.ts`: OBS's audio filters and their settings, as the core's processing table.
- `src/upgrades.ts`: upgrade scripts for buttons and triggers from older versions.
- `src/main.ts`: Companion actions, feedbacks, variables and presets.
- `test/`: tests and a pretend OBS.

# companion-module-obs-audio

A Bitfocus Companion module that turns OBS Studio's audio into a desk: auto gain rider and calibrate per input, Intech Grid faders with pickup (catch / latch / override / release), OBS's processing filters, recording tracks, and a fader and meter web page (also an OBS dock).

See [companion/HELP.md](companion/HELP.md) for how to use it.

## Building

Every push builds the module package on GitHub (Actions tab → latest run → `companion-module-obs-audio` artifact). Import the `.tgz` in Companion with **Modules → Import module package**.

Locally: `corepack enable`, `yarn install`, `yarn package`. Tests (against a pretend OBS): `yarn test`.

## Layout

- `src/engine.ts`: OBS state, meters, riders, pickup, gestures, settings store.
- `src/rider.ts`: the auto gain logic for one input.
- `src/obs.ts`: a small obs-websocket v5 client (Node's built-in WebSocket).
- `src/web.ts` and `web/page.html`: the fader page (the HTML is embedded into `src/page.ts` at build).
- `src/main.ts`: Companion actions, feedbacks, variables and presets.
- `test/`: tests and a pretend OBS.

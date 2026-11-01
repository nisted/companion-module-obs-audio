## OBS Audio

An audio desk for OBS Studio: an auto gain rider and calibrate on each input, Intech Grid (or any MIDI) faders with pickup, OBS's own processing filters, recording tracks, and a fader and meter page in any browser or as an OBS dock.

It runs alongside the official OBS module: both can be connected to OBS at once.

### Setup

1. In OBS: **Tools → WebSocket Server Settings**, tick **Enable WebSocket server**, note the port and password.
2. Add this connection, and enter OBS's address, port and password.
3. Open the fader page at `http://<this computer's address>:8890/` (the port is a setting; 0 turns it off). Set a PIN if others on the network shouldn't change things.
4. To use it inside OBS: **Docks → Custom Browser Docks**, add the same address.

### Auto gain

Each input has a **rider** (on/off) and **calibrate**.

- **This level please**: set the fader by ear, then capture that level as the target. The rider then leaves it alone while the level stays inside the band, and rides it back when it drifts out.
- **Calibrate**: brings the input to a set level once, then stops.
- **The input button** (preset "Auto gain button" for each input): **press** = this level please, **double tap** = calibrate to the input's own level, **press and hold** = calibrate to the module level. Timings are in the page's Settings → Buttons.

What it moves is a setting per input: the **OBS fader** (it measures after the fader), or a **trim** (a Gain filter it adds, before the fader; it measures before the fader, so the fader stays yours).

Every setting has a page-wide default (Settings → Auto gain defaults) and can be changed per input (in its strip's Auto gain section, or with the "Auto gain: change a setting" action). Changed values show purple; ↺ puts one back to the default.

If the rider moves the fader on an input, a Grid fader latched to that input lets go each time (it's an outside move), so use one or the other on that input.

### Intech Grid faders

Use **Fader: from a value (Intech Grid fader), with pickup** in a trigger that runs when the Grid fader's value changes, with the fader's value as **Value**. Fader 1 drives the first input in the list, fader 2 the second, and so on, unless an input is given. Pickup works as in the SQ module extension: catch band and dwell, then latched until OBS is moved elsewhere (release band and time). Show it on the fader's LED with the **Grid fader pickup LED** feedback.

### The fader page

- Strips (or rows, in Settings → Page) with the fader, pre- and post-fader meters (PRE / POST buttons), the rider's target line and band, and sections of controls.
- Sections are yours: Settings → Sections to add, rename, reorder and choose what's in each, and whether each is hidden, always open or collapsible. Settings → Inputs overrides that per input, and orders or hides inputs.
- Fader: drag; FINE (or two fingers) for small moves; double tap for 0 dB.
- Settings → Export / import: export is everything; on import tick what to apply. The settings in use are kept as an autosave first, so an import can be rolled back.

### Variables

Per input, numbered in list order (`in1_` …): name, fader, trim, mute, balance, sync, monitoring, tracks, rider status and target, calibrate level, meters (`level`, `rms`, `peak`, `pre`), and every filter's settings.

### Notes

- The input list follows OBS's input order, which isn't always the order of OBS's mixer: reorder it in Settings → Inputs.
- obs-websocket doesn't report gain reduction from OBS's compressor and limiter, so there are no gain-reduction meters.

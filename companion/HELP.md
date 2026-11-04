## OBS Audio

A proper audio desk for OBS Studio. Here's what's in the box:

- auto level and calibrate on each input (auto level used to be called the rider)
- Intech Grid (or any MIDI) faders with pickup
- PFL and solo on OBS's monitoring
- automatic switching to backup feeds
- recording control with a planned restart
- OBS's own processing filters and recording tracks
- a fader and meter page in any browser, or as an OBS dock

It's happy to share. Run it alongside the official OBS module and both can be connected to OBS at once.

### Setting it up

**1. Turn on OBS's WebSocket server.** It's off out of the box. In OBS, go to **Tools → WebSocket Server Settings**, then:

- tick **Enable WebSocket server**
- note the **Server Port** (normally 4455)
- either untick **Enable Authentication**, or press **Show Connect Info** and copy the **Server Password**

![OBS WebSocket Server Settings](images/obs-websocket-settings.png)

**2. Add this connection** and fill in:

- where OBS lives: `127.0.0.1` if it's on this computer
- the port
- the password, or leave it blank if authentication is off

Not sure what a field does? Hover over it and it'll tell you.

Heads up: connection fields don't take variables any more (that's Companion's rule now, not mine). If an old one still has a variable in it, such as `$(custom:obs_ip)`, I use the field's default instead and say so in the log. Want a variable to drive it? See **Driving the connection from a variable**, further down.

**3. Open the fader page.** The connection's page shows its address as a link. Or, take your pick:

- the **Open the fader page** preset
- the `$(OBS_Audio:page_url)` variable
- `http://<this computer's address>:8890/`

**Fader page available on** decides who can open it: every network, this computer only, or one network. If others on the network shouldn't be fiddling, set a PIN.

**4. Want it inside OBS?** Go to **Docks → Custom Browser Docks** and add the same address.

#### If it won't connect

The connection's status tells you why, in plain words:

- **Can't reach OBS:** OBS isn't running, its WebSocket server is off, or the address or port is wrong.
- **Password is wrong:** copy it again from Show Connect Info, or turn authentication off.
- **Lost the connection:** OBS closed, or the network dropped. I'll keep trying.

If OBS is on another computer, its firewall needs to let the port through.

### The fader page

Each input gets a strip, just like a sound desk. Left to right:

- **Fader and meters.** PRE is the level before the fader; POST is what's recorded. Each strip has PRE / POST / FINE buttons, and the meter shows auto level's target line and band. Drag the fader; use FINE (or two fingers) for small moves; double tap for 0 dB.
- **Channel settings.** Basic auto gain sits at the top, with sections of controls underneath. Knobs work by dragging up and down: Shift for fine, double click to reset, click the value to type one.
- **Show advanced.** Opens every auto gain and backup setting over the channel settings. **Pin** keeps it open as a third column.
- **MUTE / PFL / SOLO** live at the bottom of each strip.

Drag a strip's right edge to change its width. Tick **Match widths** to size them all together.

Every page setting lives in **⚙ Settings**, a floating panel you can drag out of the way while you keep working. You can reach them from Companion too, with **Fader page: change a setting**. That covers:

- layout, colours and meters
- tooltips on or off
- tip of the day on or off

Sections are yours to arrange however you like. In **Settings → Sections**, add, rename and reorder them, and choose what goes in each and whether each is hidden, always open or collapsible. **Settings → Inputs** overrides that per input, and orders or hides inputs.

**Settings → Export / import** exports the lot. On import, tick what to bring in. The settings in use are kept as an autosave first, so if an import goes sideways you can roll it back.

### PFL and solo

PFL and solo only ever touch OBS's **monitoring** (your headphones). The stream and the recording are left well alone. Set the monitoring device in OBS: **Settings → Audio → Advanced → Monitoring Device**.

- **PFL** sets an input's monitoring to "Monitor and Output". In the header, **PFL ADD** means PFLs add up; **PFL EXCL** means a new PFL cancels the others.
- **SOLO** lets you hear just one input. It works only while held, unless **Solo latch** is ticked. When solo ends, every PFL goes back to how it was.

### Backup feeds

Any input can be the backup of another, say a second radio mic on the same presenter. In the backup's strip, go to **Input → Backup for**, then turn on **Auto switch** under Show advanced → Backup feed.

If the main drops out, or goes much louder or quieter than usual against the backup, while the backup is healthy, it crossfades to the backup and a pop-up tells you why. **It never switches back by itself.** Once the main has looked healthy for a while, a pop-up offers:

- **Take** the main
- **Snooze**
- **Swap roles**: the backup becomes the main
- **Dismiss**

Every threshold and time is a setting, so tune away.

### Recording

- **● REC** in the header starts OBS recording. Press it while recording and it asks "Stop recording?", then "Are you definitely sure?". (Belt and braces. 🎙️)
- After stopping, it asks when recording is due to restart, with an option to start automatically. Skip leaves it stopped.
- A planned start shows as a countdown in the header. If it isn't automatic, a big **Start recording?** pop-up appears 10 minutes before (that's a setting), offering Start, Snooze, Set a new time and Dismiss. Nothing blocks the page.
- **Settings → Recording** sets OBS's recording folder and file name format (put a prefix before OBS's date codes). It also shows the last file, and how many recordings are in the folder when OBS is on this computer.

### Auto gain

Each input has **auto level** (on/off) and **calibrate**.

- **This level please:** set the fader by ear, then capture that level as the target. Auto level leaves it alone while the level stays inside the band, and rides it back when it wanders out.
- **Calibrate:** brings the input to a set level once, then stops.
- **The input button** (the per-input preset "AG"):
  - **press** = this level please
  - **double tap** = calibrate to the input's own level
  - **press and hold** = calibrate to the module level

  Timings are in Settings → Buttons.

What it moves is up to you, per input:

- the **OBS fader**: it measures after the fader
- a **trim**: a Gain filter it adds before the fader. It measures before the fader, so the fader stays yours.

Every setting has a page-wide default (Settings → Auto gain defaults) and can be changed per input under Show advanced. Changed values show purple, and ↺ puts one back to the default.

Heads up: if auto level moves the fader on an input, a Grid fader latched to that input lets go each time, because that counts as an outside move. Ride the trim instead and you keep both.

### Intech Grid faders

Use **Fader: from a value (Intech Grid fader), with pickup** in a trigger that runs when the Grid fader's value changes, with the fader's value as **Value**.

- Fader 1 drives the first input in the list, fader 2 the second, and so on, unless you give it an input.
- Pickup works as in the SQ module extension: catch band and dwell, then latched until OBS is moved elsewhere (release band and time).
- The catch and release settings belong to each connection: set them on the connection page, under **Grid fader pickup**. A main and a backup OBS connection each get their own. They also show as variables (`grid_catch_band`, `grid_dwell_ms`, `grid_release_band`, `grid_release_ms`). A value typed into an action overrides the connection's setting for that action only.
- Show it on the fader's LED with the **Grid fader pickup LED** feedback.

### Presets

**Overall:**

- open the fader page, and its address
- connection status
- update available
- auto level on or off for every input
- record
- next planned start
- pop-ups waiting

**Per input:**

- the AG button, auto level, status, this level and the two calibrates
- mute, PFL, solo (hold and latch)
- level, fader ±1 / ±3 / 0, trim ±1
- recording tracks
- filter on/off
- backup switch

### Action recorder

Companion's action recorder picks up changes made on the fader page, and changes made in OBS itself, as this module's actions:

- fader, mute, balance, sync and trim
- tracks
- filters

### Variables

Per input, numbered in list order (`in1_` …):

- name, fader, trim, mute, balance, sync, monitoring, tracks
- PFL and backup state
- auto level status and target (`auto_level`, `auto_level_on`, `target`), calibrate level
- meters (`level`, `rms`, `peak`, `pre`)
- every filter's settings

Overall:

- `page_url`
- `obs_error`
- recording: `rec_state`, `rec_time`, `rec_next`, `rec_countdown`, `rec_auto`, `rec_folder`, `rec_files`
- `solo`
- `notices`

### "Rider" is now "Auto Level" (0.2.0)

Same feature, better name. Everything that said rider now says auto level: the page, actions, feedbacks, presets and variables. Your old buttons and triggers are upgraded by themselves when you update, so nothing needs redoing:

- **Auto gain: rider on / off** → **Auto gain: auto level on / off**
- **Auto gain: every rider on / off** → **Auto gain: auto level on / off for every input**
- **rider status colours** and **rider is on** feedbacks → the **auto level** ones
- "Rider on" in **Auto gain: change a setting** → "Auto level on"
- `in1_rider` → `in1_auto_level`, `in1_rider_on` → `in1_auto_level_on` (in action and feedback fields)

The old variables `inN_rider` and `inN_rider_on` still work for now, marked *deprecated* in the variable list. They'll go in a later version, so swap them over when you get a mo. Button text that shows an old variable keeps working too, as the old ones are still there. Saved settings (targets, every per-input choice) carry straight over.

### Variables and expressions in actions and feedbacks

Companion fills in variables for me now, before an action or feedback runs. So:

- **Text fields** (an input name, a dB value, a colour and so on) take variables as they always have, such as `$(custom:mic_level)`.
- **Every other field** (dropdowns, tickboxes) can be switched to an **expression** with the little toggle next to it. Handy when you want a variable to pick the mode, say.
- A few fields that decide what else is shown (like **Mode** or **Value is**) stay as plain choices, so the options underneath don't jump about.

Old buttons and triggers carry on as they were.

### Driving the connection from a variable

Connection fields can't take variables any more, but you can still change them on the fly:

1. On the connection page, tick **Can be set by the action** next to each field you want to hand over. That field then locks on the page and shows what the action last set (the password and PIN stay hidden).
2. Add the **Connection: set settings** action. Its options are just the fields you ticked. Fill in the ones to change (variables and expressions welcome); leave a field blank to leave it as is.
3. To follow a variable, make a trigger on **variable changed** for that variable, with **Connection: set settings** as its action.

When it runs, I write the new values into the connection and reconnect, or restart the fader page, as needed. A number field given something that isn't a sensible number (not a number, not whole, or outside its range, like port 99999) is skipped, with a note in the log. The action's tooltips show each field's range.

Untick a field and it goes back to whatever you'd typed before you ticked it. No harm done.

### Good to know

- The input list follows OBS's input order, which isn't always the order of OBS's mixer. Reorder it in Settings → Inputs.
- obs-websocket doesn't report gain reduction from OBS's compressor and limiter, so there are no gain-reduction meters. Sorry about that.
- Under the hood, OBS Audio runs on the Rebels' shared audio core ([rebel-audio-core](https://github.com/nisted/rebel-audio-core)), the same one ATEM Audio will use. A fix there lands in both.
- The page uses web fonts when online and falls back to built-in fonts at a venue with no internet. So no drama when the Wi-Fi's down.

### Psst. This one's got mates. 🍹

OBS Audio is part of a little crew of Companion modules: some brand new, some old favourites given a good tweak. Want to know who else is in the crew, or grab the freshest version of each one? It's all here: [github.com/nisted/companion-modules](https://github.com/nisted/companion-modules)

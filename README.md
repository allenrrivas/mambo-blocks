# Mambo Blocks

Block coding for the Parrot Mambo, running entirely in a browser on an iPad.
No Raspberry Pi, no bridge computer, no Mac, no Xcode. The iPad talks Bluetooth
straight to the drone.

## How it works

The Mambo is a standard BLE GATT peripheral. This app reimplements Parrot's
command protocol in JavaScript on top of Web Bluetooth, so a static web page can
fly it directly.

```
  Blockly UI  ──▶  runner.js (interpreter)  ──▶  mambo-ble.js  ──▶  drone
```

The protocol was ported from [pyparrot](https://github.com/amymcgovern/pyparrot)
(Amy McGovern, MIT) — specifically `pyparrot/networking/bleConnection.py` — and
cross-checked against gobot's minidrone driver. Every packet builder in
`mambo-ble.js` has been verified byte-for-byte against pyparrot's `struct.pack`
output.

## Requirements

**On the iPad: the [Bluefy](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055)
browser.** Safari does not support Web Bluetooth and never has — Apple has
declined to ship it. Bluefy is free and ships its own Bluetooth stack.

**The page must be served over HTTPS.** Web Bluetooth requires a secure context.
`file://` will not work. GitHub Pages is the easiest free option:

```bash
git init && git add -A && git commit -m "Mambo Blocks"
```

Push to a GitHub repo, then Settings → Pages → deploy from `main` / root. You get
an `https://<user>.github.io/<repo>/` URL — open that in Bluefy.

## Local development

```bash
python tools/serve.py
```

Then open `http://localhost:8777`. localhost counts as a secure context, so Web
Bluetooth works from a desktop Chrome/Edge browser for testing without an iPad.

**Use `tools/serve.py`, not `python -m http.server`.** The built-in server sends
`Last-Modified`, so browsers heuristically cache the ES modules and you end up
testing old code while the app still loads and mostly works — which is very hard
to spot. `serve.py` sends `no-store` and is threaded, so reloads are always
fresh.

## Using it

1. Put the drone on a flat surface and turn it on. Do not move it — it takes a
   flat-trim reading on connect.
2. Tap **Connect drone** and pick `Mambo_xxxxxx` from the list.
3. Drag blocks, tap **Run**.
4. **STOP** aborts the program mid-move and lands. **Land** does the same by hand.

The workspace saves to `localStorage`, so a kid's program survives a reload on
their own iPad.

## Safety notes

- **STOP lands, it does not cut the motors.** The red `EMERGENCY STOP` block in
  the Safety category cuts motors instantly — the drone will *fall*. That is the
  right behaviour for a fly-away and the wrong behaviour for everything else.
- The runner polls the abort flag between every block and inside every timed
  move, so a 10-second flight can be cut short.
- If the program throws for any reason, the runner lands rather than leaving the
  drone hovering.
- `flip` needs roughly 1.5 m of clear space in every direction.
- **The multi-flip block needs far more.** `flip N times in a row` deliberately
  skips the settle between flips, so altitude loss compounds with no chance to
  recover. Climb first. Gaps under about a second may also be silently dropped
  by the drone's flight controller, which will not accept a flip while it is
  still recovering from the previous one.
- Speeds are capped at 100 and turns at ±180° by the block definitions, so a kid
  cannot type in a number that means something surprising.

## Why the heartbeat matters

`mambo-ble.js` sends a PCMD frame every 50 ms for the entire session, not just
during moves — the same thing gobot's `StartPcmd()` does. Two reasons:

- **Chrome on Windows drops idle links.** It does not set `MaintainConnection`
  on its WinRT GATT session the way `bleak` does, so Windows tears the
  connection down after ~5 s of silence. Constant traffic prevents that.
- It is how the drone expects to be flown. Blocks set the stick values; the
  heartbeat transmits them.

**Keep the page in the foreground while flying.** Browsers throttle timers in
background tabs to roughly 1 Hz, which starves the heartbeat. The app watches
for this and lands automatically if the page is hidden mid-program.

## Files

| File | What it does |
|---|---|
| `index.html` | Page shell, layout, styling |
| `js/mambo-ble.js` | Web Bluetooth driver — UUIDs, handshake, packet builders |
| `js/blocks.js` | Block definitions, toolbox, starter program |
| `js/runner.js` | Walks the block tree and drives the drone |
| `js/app.js` | Wires workspace, drone and buttons together |

## Design notes

`runner.js` is an **interpreter, not a code generator**. It walks the Blockly
tree and calls driver methods directly. Nothing a kid builds is ever `eval`'d,
the abort flag can be checked between every step, and the running block can be
highlighted. Numeric inputs only accept literal `math_number` blocks — there is
no expression evaluation anywhere in the pipeline.

## Status

**Flown.** Take off, flip, hover and land all confirmed on real hardware.

Verified against the drone:

- Connects, exposes all 4 services and all 3 required characteristics
- Battery and flying state parse correctly (reported 68%, `landed`)
- 8 of 10 notification channels enable; `fd24`/`fd54` are write-only FTP
  characteristics with no notify bit, which is expected

Verified without the drone:

- All 8 packet types match pyparrot byte-for-byte, including signed values
  (turn -90 deg -> `a6 ff`, throttle -30 -> `e2`)
- Block interpreter: sequencing, nested `repeat`, correct call order
- STOP aborts a 5-second move mid-flight, neutralises the sticks, then lands

Not yet tested: **Bluefy on the iPad.** Everything so far has been Chrome on
Windows, which is the same Web Bluetooth API but a different implementation.

## First flight checklist

1. Open in Bluefy, tap Connect. If the drone does not appear in the picker, the
   `namePrefix` filter in `mambo-ble.js` may need adjusting to match your drone's
   advertised name.
2. Check the battery readout populates — that proves notification parsing works.
3. Run take off → hover 2s → land, **outdoors or in a large room**, standing clear.
4. Test STOP mid-hover before trusting it with kids.

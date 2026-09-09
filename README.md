# Mambo Blocks

Classroom drone programming for the Parrot Mambo. Students build flights on
iPads in a browser and send them to the teacher's laptop, which holds the only
Bluetooth link and flies each program in turn.

```
  iPads (plain Safari, plain HTTP)          Teacher's laptop
  ┌──────────────────────┐                  ┌───────────────────────────┐
  │ Blockly workspace    │  POST /api/submit│ tools/serve.py            │
  │ [ Send to teacher ]  ├─────────────────▶ │ + submission queue        │
  └──────────────────────┘                  │            ↓              │
                                            │ teacher.html: review→Fly  │
                                            │            ↓ Web Bluetooth│
                                            └────────────┼──────────────┘
                                                         ▼   drone
```

Nothing leaves the room — no cloud, no accounts, no student data off-site, and
it works with the internet down.

## Why this shape

**The drone cannot store a program.** The Mambo has no user-programmable
memory. Every command streams live over BLE and the laptop must keep sending a
50 ms heartbeat for the whole flight — close the tab mid-program and the drone
stops. So the laptop flies the drone from the student's instructions rather
than uploading anything to it.

**Students never hold a Bluetooth connection**, which is what makes the iPad
side easy. Web Bluetooth was the only reason this needed the third-party Bluefy
browser and an HTTPS origin. Authoring-only means plain Safari over plain HTTP
on the local network: nothing to install, no MDM request, no deployment.

**The teacher is the safety gate.** One person reviews each program and decides
when it flies, which is a far better model than thirty children each holding a
live link to a spinning-propeller device.

## Running a lesson

On the laptop:

```bash
python tools/serve.py
```

It prints both URLs — give students the LAN one, open the teacher one yourself:

```
students -> http://192.168.x.x:8777/
teacher  -> http://localhost:8777/teacher.html
```

The teacher console needs **Chrome or Edge**. Safari and Firefox have no Web
Bluetooth, so they cannot talk to the drone.

Then: put the drone on a flat surface and turn it on, click **Connect drone**,
pick a submission, read the *What it will do* panel, and click **Fly this**.

Students put their name in, build a flight, and tap **Send to teacher**.
Resubmitting replaces their pending entry rather than adding another, so nobody
can flood the queue. Submissions persist to `submissions.jsonl`, so restarting
the server mid-lesson is not a disaster.

## Requirements

- **Laptop:** Chrome or Edge, Python 3, Bluetooth LE.
- **iPads:** any modern browser. Must be able to reach the laptop's IP — some
  managed school networks use client isolation, which blocks device-to-device
  traffic and would break this. Test by loading the student URL on one iPad.
- **Drone:** a Parrot Mambo. The FPV camera is not needed; this uses BLE.

## Safety notes

- **STOP lands, it does not cut the motors.** The red `EMERGENCY STOP` block in
  the Safety category cuts motors instantly — the drone will *fall*. That is the
  right behaviour for a fly-away and the wrong behaviour for everything else.
- The runner polls the abort flag between every block and inside every timed
  move, so a 10-second flight can be cut short.
- If a program throws for any reason, the runner lands rather than leaving the
  drone hovering.
- Background tabs get throttled to ~1 Hz, which starves the heartbeat. The
  teacher console lands automatically if its page is hidden mid-program — keep
  it in the foreground while flying.
- `flip` needs roughly 1.5 m of clear space in every direction.
- **The multi-flip block needs far more.** `flip N times in a row` deliberately
  skips the settle between flips, so altitude loss compounds with no chance to
  recover. Climb first. Gaps under about a second may also be silently dropped
  by the drone's flight controller, which will not accept a flip while it is
  still recovering from the previous one.
- Speeds are capped at 100 and turns at ±180° by the block definitions, so a
  student cannot type in a number that means something surprising.

## Why the heartbeat matters

`mambo-ble.js` sends a PCMD frame every 50 ms for the entire session, not just
during moves — the same thing gobot's `StartPcmd()` does. Two reasons:

- **Chrome on Windows drops idle links.** It does not set `MaintainConnection`
  on its WinRT GATT session the way `bleak` does, so Windows tears the
  connection down after ~5 s of silence. Constant traffic prevents that.
- It is how the drone expects to be flown. Blocks set the stick values; the
  heartbeat transmits them.

## Files

| File | What it does |
|---|---|
| `index.html` / `js/student.js` | Student view — author and submit, no drone code |
| `teacher.html` / `js/teacher.js` | Teacher console — queue, review, fly |
| `js/mambo-ble.js` | Web Bluetooth driver — UUIDs, handshake, packet builders |
| `js/blocks.js` | Block definitions, toolbox, starter program |
| `js/runner.js` | Walks the block tree and drives the drone |
| `js/workspace.js` | Shared Blockly setup and the plain-English describer |
| `css/app.css` | Styling for both views |
| `tools/serve.py` | Classroom server: static files + submission queue API |
| `tools/ble-doctor.py` | Diagnoses the BLE stack without involving a browser |

## The protocol

Ported from [pyparrot](https://github.com/amymcgovern/pyparrot) (Amy McGovern,
MIT) — specifically `pyparrot/networking/bleConnection.py` — and cross-checked
against gobot's minidrone driver. All fields are little-endian:

```
[dataType u8][seq u8][projectId u8][classId u8][cmdId u16][...params]
```

Two things that are easy to miss and cost real debugging time:

- **The drone stays silent until asked.** Battery and flying state only start
  arriving after a `common(0)/Common(4)/AllStates(0)` request, so `connect()`
  issues one. Without it the readouts stay blank forever.
- **Telemetry arrives on `fb0e`, not `fb0f`.** Subscribe to both.

`pyparrot` remains the reference for anything unimplemented here — the claw and
gun accessories, `MaxTilt`, speed settings, the Minicam.

## Design notes

`runner.js` is an **interpreter, not a code generator**. It walks the Blockly
tree and calls driver methods directly. Nothing a student builds is ever
`eval`'d, the abort flag can be checked between every step, and the running
block can be highlighted. Numeric inputs only accept literal `math_number`
blocks — there is no expression evaluation anywhere in the pipeline.

`tools/serve.py` disables caching deliberately. `python -m http.server` sends
`Last-Modified`, so browsers heuristically cache the ES modules and you end up
testing old code while the app still loads and mostly works — which is very
hard to spot. It is also threaded, because a single-threaded server deadlocks
behind the browser's keep-alive connections.

## Status

**Flown.** Take off, flip, hover and land confirmed on real hardware, with the
connection held stable across repeated runs.

Verified against the drone:

- Connects, exposes all 4 services and all 3 required characteristics
- Battery and flying state parse correctly
- 8 of 10 notification channels enable; `fd24`/`fd54` are write-only FTP
  characteristics with no notify bit, which is expected

Verified without the drone:

- All 8 packet types match pyparrot byte-for-byte, including signed values
  (turn -90 deg -> `a6 ff`, throttle -30 -> `e2`)
- Block interpreter: sequencing, nested `repeat`, multi-flip, correct call order
- STOP aborts a 5-second move mid-flight, neutralises the sticks, then lands
- Submission API: submit, queue, per-student replacement, status updates,
  persistence across restart, and 400s on malformed input
- Student submit flow and teacher review flow end to end in the browser

Not yet tested: **iPads on the real classroom network.** Everything so far has
been localhost. Client isolation on managed school wifi is the one assumption
this design rests on.

## Not built yet

- **Python mode.** Students would write Python instead of blocks. Only the
  teacher's laptop needs the runtime, so [Pyodide](https://pyodide.org) (real
  CPython, ~11.6 MB) is affordable here. Run it in a Web Worker and
  `terminate()` on STOP — `setInterruptBuffer` needs a `SharedArrayBuffer`,
  which needs COOP/COEP headers. Naming the API after pyparrot's would let
  student code transfer to a real Python environment later.
- **A "Show Python" button** on the block view, so students can see the text
  equivalent of what they built. Blockly has code generation built in.
- **C++ mode.** Harder to justify: JSCPP has been dormant since 2021, and
  clang-in-WASM is ~40 MB and experimental. A purpose-built C-subset
  interpreter would be the honest path if a curriculum demands it.

# Mambo Blocks

Classroom drone programming for the Parrot Mambo. Students build flights on
iPads in a browser - with **blocks or Python** - and send them to the teacher's
laptop, which holds the only Bluetooth link and flies each program in turn.

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

A submission's blocks can be panned, scrolled, wheeled and zoomed, and are
centred when you select one. The blocks themselves stay locked, so you cannot
detach one by accident and fly something other than what the student wrote.

Students put their name in, build a flight, and tap **Send to teacher**.
Resubmitting replaces their pending entry rather than adding another, so nobody
can flood the queue. Submissions persist to `submissions.jsonl`, so restarting
the server mid-lesson is not a disaster.

## Seeing the Python for your blocks

In blocks mode, **Show Python** opens a read-only pane with the Python
equivalent, regenerated as the blocks change:

```python
takeoff()
fly("up", 1.5, 50)
for i in range(4):
    fly("forward", 1, 40)
    turn("right", 90)
flip_times("front", 3, 1.2)
land()
```

Students get the same program three ways at once - blocks, Python, and the
plain-English steps - which is the point of having both modes in one app
rather than two separate tools. It is read-only on purpose: nothing to
reconcile, and no way to lose a Python draft by switching modes. The toggle
remembers its setting, and hides itself in Python mode where the code is
already the main view.

`toPython()` in `workspace.js` is a separate walker from `runner.js`. The
runner drives the drone; this only has to be readable and correct enough to
learn from. It emits calls from the same API `py-worker.js` exposes, so what a
student sees is genuinely runnable in Python mode - verified by feeding
generated output through the server's CPython syntax check. Nested repeats get
`i`, `j`, `k` rather than shadowing, and an empty loop emits `pass` so the
result always compiles.

## Python mode

Students can switch from blocks to Python and write plain, synchronous code:

```python
takeoff()
for i in range(4):
    fly("forward", 1, 40)
    turn("right", 90)
print("square done")
land()
```

No `await` anywhere, and no source rewriting. That works because of **JSPI**
(WebAssembly stack switching, Chrome 137+): each API function blocks via
`pyodide.ffi.run_sync` while the drone call round-trips, so the code reads as
ordinary Python. `loadPyodide` needs `enableRunUntilComplete: true` for it.

**It runs in a Web Worker, and STOP terminates that worker.** Students write
infinite loops. On the main thread a `while True: pass` would peg the tab and
the STOP button's own click handler would never get to run - nothing
cooperative can help, because there is no suspension point. Killing the worker
works regardless of what the code is doing; the drone is then landed from the
main thread.

The obvious alternative does not work here: Pyodide's `setInterruptBuffer`
needs a `SharedArrayBuffer`, which needs COOP/COEP headers.

Web Bluetooth does not exist in workers, so every drone call is proxied to the
main thread by `postMessage`.

**Syntax is checked on submit, by the server.** `tools/serve.py` is Python, so
it compiles the student's program with the real CPython parser and returns the
line and message. They find out immediately instead of when the teacher tries
to fly it.

### The editor

Code is themed with **One Dark** (highlight.js `atom-one-dark`), in both the
student editor and the teacher's read-only view.

The editor is a transparent `<textarea>` layered over a highlighted `<pre>`,
not a JS editor component. Swapping in CodeMirror or Ace would hand text
input, selection, the caret and the iPad virtual keyboard over to a library on
the device this project has tested least. Keeping the native textarea means
editing behaves exactly as the browser intends and only the colours are ours.

Alignment holds because neither layer wraps and both share font, size,
line-height, padding and tab-size. If you touch that CSS, check the caret still
sits on the character it is supposed to.

### The API students see

| Friendly | pyparrot-compatible alias |
|---|---|
| `takeoff()` / `land()` | `safe_takeoff()` / `safe_land()` |
| `hover(2)` / `wait(2)` | `smart_sleep(2)` |
| `fly("forward", 1, 40)` | `fly_direct(roll=, pitch=, yaw=, vertical_movement=, duration=)` |
| `turn("right", 90)` | `turn_degrees(90)` |
| `flip("front")` | `flip("front")` |
| `flip_times("front", 3, 1.2)` | - |
| `emergency()` | `emergency()` |

`flip_times(direction, times, gap)` chains flips without the settle between
them, matching the multi-flip block. It rejects out-of-range values rather than
clamping them - a student who asks for 20 flips is told no, not quietly given
five - and each drone call validates its arguments, so mistakes surface as
`line 4: flip_times(): times must be between 2 and 5, got 20`.

Every other call carries an automatic settle: `takeoff()` does not return for
~3s, `flip()` for ~2.5s, `turn()` for ~1.5s. So `for i in range(3):
flip("front")` will *not* reproduce `flip_times` - that is what the dedicated
call is for.

The aliases are deliberate: code written here transfers to a real Python
environment with pyparrot later, so the iPad is an on-ramp rather than a
dialect dead end.

Errors report the student's own line numbers. The API prelude is compiled as a
separate unit under its own filename - prepended to their code instead, a
mistake on line 2 gets reported as line 46.

## Requirements

- **Laptop:** Chrome or Edge, Python 3, Bluetooth LE.
- **iPads:** any modern browser. Must be able to reach the laptop's IP — some
  managed school networks use client isolation, which blocks device-to-device
  traffic and would break this. Test by loading the student URL on one iPad.
- **Drone:** a Parrot Mambo. The FPV camera is not needed; this uses BLE.

## Safety notes

- **STOP always lands**, whether or not a program is running. It used to return
  early when nothing was running, which is exactly the state you are in when a
  program ends without `land()` - the red button did nothing at the moment
  someone would most want it.
- **A program that never says `land()` is landed for you** when it finishes,
  rather than leaving the drone hovering until the battery gives out.
- **A mid-flight disconnect stops the program.** Both runners used to check the
  link only at the start, and would keep issuing commands into a dead
  connection.
- **Flying is refused below 15% battery.** Mambos get erratic and drop hard on a
  low cell. Land and STOP keep working; there is a warning banner from 30%.
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
| `js/py-worker.js` | Pyodide in a Web Worker; the Python API students see |
| `js/python-runner.js` | Main-thread half of Python mode: call proxy and kill switch |
| `js/code-editor.js` | Syntax-highlighted Python editor and read-only viewer |
| `js/workspace.js` | Shared Blockly setup and the plain-English describer |
| `css/app.css` | Styling for both views |
| `tools/serve.py` | Classroom server: static files + submission queue API |
| `tools/ble-doctor.py` | Diagnoses the BLE stack without involving a browser |
| `tools/make-icons.py` | Regenerates `favicon.ico` and `apple-touch-icon.png` |

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

## Icons

`favicon.svg` is the source of truth for the design; `tools/make-icons.py`
renders the raster versions. Pillow is not a dependency, so the PNG encoder and
the ICO container are written on top of `zlib`. Run it only when the design
changes - the outputs are checked in.

The glyph is drawn at 4x and downsampled rather than aliased. The first pass
used 2-unit arms, which come out 1px wide at 16px and disappear entirely; they
are 3 units now. Anything you change here should be checked at 16px, not just
in the SVG.

`apple-touch-icon.png` means students can add the page to an iPad home screen
and get a real icon.

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
- Python mode: plain sync Python drives the drone in the right order; `print()`
  captured; errors report the student's own line numbers (bad argument,
  NameError and SyntaxError all checked); `while True: pass` killed by STOP
  with the drone landed; the worker recovers for the next program
- Server-side syntax validation, including bad indentation and non-text input
- STOP aborts a 5-second move mid-flight, neutralises the sticks, then lands
- Submission API: submit, queue, per-student replacement, status updates,
  persistence across restart, and 400s on malformed input
- Student submit flow and teacher review flow end to end in the browser

Not yet tested: **iPads on the real classroom network.** Everything so far has
been localhost. Client isolation on managed school wifi is the one assumption
this design rests on.

## Not built yet

- **C++ mode.** Harder to justify: JSCPP has been dormant since 2021, and
  clang-in-WASM is ~40 MB and experimental. A purpose-built C-subset
  interpreter would be the honest path if a curriculum demands it.

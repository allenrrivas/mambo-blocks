/*
 * mambo-ble.js — Parrot Mambo driver over Web Bluetooth.
 *
 * Protocol taken from pyparrot (Amy McGovern, MIT) —
 * see pyparrot/networking/bleConnection.py — and cross-checked against
 * gobot's minidrone driver. All multi-byte fields are little-endian.
 *
 * Packet layout for every command:
 *   [dataType u8][seq u8][projectId u8][classId u8][cmdId u16][...params]
 */

const uuid = (short) => `9a66${short}-0800-9191-11e4-012d1540cb8e`;

const SERVICES = {
  command: uuid('fa00'),
  notify: uuid('fb00'),
  ftp: uuid('fd21'),
  ftpUpd: uuid('fd51'),
};

// Send channels. Each keeps its own sequence counter.
const CHAR = {
  pcmd: uuid('fa0a'),      // continuous flight control, no ack
  command: uuid('fa0b'),   // takeoff / land / flip, acked
  emergency: uuid('fa0c'), // high-priority channel
  ack: uuid('fa1e'),
};

// The "magic handshake": the drone ignores us until notifications are
// enabled on all of these. pyparrot writes 0x0100 to each CCCD by hand;
// Web Bluetooth's startNotifications() does exactly that for us.
const HANDSHAKE = [
  uuid('fb0e'), uuid('fb0f'), uuid('fb1b'), uuid('fb1c'),
  uuid('fd22'), uuid('fd23'), uuid('fd24'),
  uuid('fd52'), uuid('fd53'), uuid('fd54'),
];

// Write-only FTP characteristics: they appear in the handshake list but have no
// notify bit, so start_notify legitimately fails on them.
const WRITE_ONLY = new Set([uuid('fd24'), uuid('fd54')]);

const DATA_NO_ACK = 2, DATA_WITH_ACK = 4;
const PROJ_COMMON = 0, PROJ_MINIDRONE = 2;
const CLS_PILOTING = 0, CLS_PILOTING_STATE = 3, CLS_ANIMATIONS = 4;
const CLS_COMMON = 4, CLS_COMMON_STATE = 5; // CLS_COMMON is in the common project
const CMD_FLATTRIM = 0, CMD_TAKEOFF = 1, CMD_PCMD = 2, CMD_LANDING = 3, CMD_EMERGENCY = 4;
const CMD_FLIP = 0, CMD_CAP = 1, CMD_ALL_STATES = 0;

const FLIP_DIRECTION = { front: 0, back: 1, right: 2, left: 3 };
const FLYING_STATE = ['landed', 'takingoff', 'hovering', 'flying',
  'landing', 'emergency', 'rolling', 'init'];

export class MamboBLE {
  constructor() {
    this.device = null;
    this.server = null;
    this.chars = {};
    this.counters = { pcmd: 0, command: 0, emergency: 0, ack: 0 };
    this.battery = null;
    this.flyingState = 'unknown';
    // Current stick position, transmitted continuously by the heartbeat.
    this.sticks = { roll: 0, pitch: 0, yaw: 0, gaz: 0 };
    this._heartbeatRunning = false;
    this.listeners = { battery: [], state: [], log: [], disconnect: [] };
    // GATT rejects overlapping operations, so every write goes through
    // this promise chain rather than racing.
    this._queue = Promise.resolve();
  }

  on(event, fn) { this.listeners[event].push(fn); return this; }

  _emit(event, ...args) { this.listeners[event].forEach((f) => f(...args)); }

  _log(msg) { this._emit('log', msg); }

  get connected() { return !!(this.server && this.server.connected); }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error(
        'Web Bluetooth unavailable. On iPad you must use the Bluefy browser — '
        + 'Safari does not support Web Bluetooth.'
      );
    }

    this._log('Requesting drone...');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'Mambo' },
        { namePrefix: 'Swing' },
        { namePrefix: 'RS_' },
        { namePrefix: 'Airborne' },
      ],
      optionalServices: Object.values(SERVICES),
    });

    // requestDevice may hand back the same device object on a later attempt,
    // so only ever wire the disconnect handler once.
    if (!this.device._mamboWired) {
      this.device._mamboWired = true;
      this.device.addEventListener('gattserverdisconnected', () => {
        if (this._connecting) return; // teardown between retries, not a real drop
        this._stopHeartbeat();
        this._log('Drone disconnected.');
        this._emit('disconnect');
      });
    }

    await this._connectGatt();
    await this._discover();

    await this._handshake();
    this._log('Connected. Sending flat trim...');
    await this.flatTrim();
    // The drone stays silent until asked: battery and flying state only start
    // arriving after an AllStates request. pyparrot calls this
    // ask_for_state_update().
    await this.askForStateUpdate();
    this._startHeartbeat();
    this._log('Heartbeat started (keeps the link alive).');
    return this.device.name;
  }

  /** common(0) / Common(4) / AllStates(0) — makes the drone dump its state. */
  askForStateUpdate() {
    return this._simpleCommand('command', DATA_WITH_ACK, PROJ_COMMON, CLS_COMMON, CMD_ALL_STATES);
  }

  /**
   * Mambo BLE connects fail often enough that pyparrot's own API is
   * connect(num_retries) and every example passes 3. Half-open links are the
   * usual cause, so we explicitly tear down before each retry.
   */
  async _connectGatt(retries = 5) {
    this._connecting = true;
    try {
      await this._connectGattLoop(retries);
    } finally {
      this._connecting = false;
    }
  }

  async _connectGattLoop(retries) {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        this._log(`Connecting to ${this.device.name} (attempt ${attempt}/${retries})...`);
        this.server = await this.device.gatt.connect();
        if (this.server.connected) {
          this._log('GATT connected.');
          // Windows in particular needs a beat before service discovery.
          await new Promise((r) => setTimeout(r, 600));
          return;
        }
        throw new Error('GATT reported not connected.');
      } catch (err) {
        this._log(`  attempt ${attempt} failed: ${err.name || 'Error'} — ${err.message}`);
        try { this.device.gatt.disconnect(); } catch (e) { /* already down */ }
        if (attempt === retries) {
          throw new Error(
            `Could not connect after ${retries} tries. Power-cycle the drone, `
            + 'make sure no phone or tablet running FreeFlight is connected to it, '
            + 'and that it is not paired in your Bluetooth settings.'
          );
        }
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }

  /** Cache every characteristic we might touch. */
  async _discover() {
    this._log('Discovering services...');
    for (const svcUuid of Object.values(SERVICES)) {
      let service;
      try {
        service = await this.server.getPrimaryService(svcUuid);
      } catch (err) {
        continue; // FTP services are optional for flight
      }
      const list = await service.getCharacteristics();
      for (const c of list) this.chars[c.uuid.toLowerCase()] = c;
    }
    this._log(`Found ${Object.keys(this.chars).length} characteristics.`);

    // Discovery can stall for tens of seconds and then come back empty because
    // the link died underneath it. Say that, rather than blaming the drone.
    if (!this.server.connected) {
      throw new Error('Link dropped during service discovery. Retrying usually works.');
    }

    for (const key of ['pcmd', 'command', 'emergency']) {
      if (!this.chars[CHAR[key]]) {
        throw new Error(
          `Connected, but characteristic "${key}" (${CHAR[key]}) is missing. `
          + 'The drone may need a power cycle.'
        );
      }
    }
  }

  async _handshake() {
    let enabled = 0;
    for (const u of HANDSHAKE) {
      const c = this.chars[u];
      if (!c) continue;
      try {
        await c.startNotifications();
        c.addEventListener('characteristicvaluechanged',
          (e) => this._onNotification(e.target.value));
        enabled += 1;
      } catch (err) {
        // fd24 and fd54 are write-only FTP "handling" characteristics with no
        // notify bit. pyparrot writes to them blindly; refusing here is normal.
        if (!WRITE_ONLY.has(u)) {
          this._log(`Could not enable notifications on ${u.slice(4, 8)}: ${err.message}`);
        }
      }
    }
    this._log(`Handshake complete (${enabled}/8 notification channels).`);
  }

  _onNotification(dataView) {
    if (dataView.byteLength < 6) return;
    // Skip the 2-byte BLE framing header, then read the ARCOMMAND.
    const project = dataView.getUint8(2);
    const cls = dataView.getUint8(3);
    const cmd = dataView.getUint16(4, true);

    if (project === PROJ_COMMON && cls === CLS_COMMON_STATE && cmd === 1) {
      this.battery = dataView.getUint8(6);
      this._emit('battery', this.battery);
    } else if (project === PROJ_MINIDRONE && cls === CLS_PILOTING_STATE && cmd === 1) {
      const state = dataView.getUint32(6, true);
      this.flyingState = FLYING_STATE[state] || `state-${state}`;
      this._emit('state', this.flyingState);
    }
  }

  _nextSeq(channel) {
    this.counters[channel] = (this.counters[channel] + 1) % 256;
    return this.counters[channel];
  }

  /* Serialise writes and tolerate the three spellings of the write API
     that different Web Bluetooth implementations ship. */
  _write(channel, bytes, quiet = false) {
    const op = this._queue.then(async () => {
      const c = this.chars[CHAR[channel]];
      if (!c) throw new Error(`Characteristic ${channel} not available.`);
      const buf = new Uint8Array(bytes);
      if (c.writeValueWithoutResponse) return c.writeValueWithoutResponse(buf);
      if (c.writeValueWithResponse) return c.writeValueWithResponse(buf);
      return c.writeValue(buf);
    });
    // The queue must stay resolved, or one failed write poisons every write
    // that follows it. Callers still see the rejection through `op`.
    this._queue = op.catch(() => {});
    return op.catch((err) => {
      // The heartbeat fires 20x a second; logging every failure on a dead link
      // would bury the real message, so it fails silently and breaks its loop.
      if (!quiet) this._log(`Write failed: ${err.message}`);
      throw err;
    });
  }

  /** Command with no parameters: [type, seq, proj, class, cmd u16] */
  _simpleCommand(channel, dataType, project, cls, cmd) {
    return this._write(channel, [
      dataType, this._nextSeq(channel), project, cls, cmd & 0xff, (cmd >> 8) & 0xff,
    ]);
  }

  flatTrim() {
    return this._simpleCommand('command', DATA_WITH_ACK, PROJ_MINIDRONE, CLS_PILOTING, CMD_FLATTRIM);
  }

  takeoff() {
    return this._simpleCommand('command', DATA_WITH_ACK, PROJ_MINIDRONE, CLS_PILOTING, CMD_TAKEOFF);
  }

  land() {
    return this._simpleCommand('command', DATA_WITH_ACK, PROJ_MINIDRONE, CLS_PILOTING, CMD_LANDING);
  }

  /** Cuts the motors instantly. Goes out on the high-priority channel. */
  emergency() {
    return this._simpleCommand('emergency', DATA_WITH_ACK, PROJ_MINIDRONE, CLS_PILOTING, CMD_EMERGENCY);
  }

  /** Flip: enum parameter is a u32, and cmdId is followed by a pad byte. */
  flip(direction) {
    const dir = FLIP_DIRECTION[direction];
    if (dir === undefined) throw new Error(`Unknown flip direction: ${direction}`);
    return this._write('command', [
      DATA_WITH_ACK, this._nextSeq('command'), PROJ_MINIDRONE, CLS_ANIMATIONS,
      CMD_FLIP, 0,
      dir & 0xff, 0, 0, 0,
    ]);
  }

  /** Turn in place. degrees is a signed 16-bit value, clamped to +/-180. */
  turn(degrees) {
    const d = Math.max(-180, Math.min(180, Math.round(degrees)));
    const v = d < 0 ? d + 0x10000 : d;
    return this._write('command', [
      DATA_WITH_ACK, this._nextSeq('command'), PROJ_MINIDRONE, CLS_ANIMATIONS,
      CMD_CAP, 0,
      v & 0xff, (v >> 8) & 0xff,
    ]);
  }

  /**
   * One PCMD frame. Values are -100..100.
   * [type, seq, proj, class, cmd u16, flag u8, roll i8, pitch i8, yaw i8, gaz i8, timestamp u32]
   */
  _pcmdFrame(roll, pitch, yaw, gaz, quiet = false) {
    const i8 = (n) => {
      const v = Math.max(-100, Math.min(100, Math.round(n)));
      return v < 0 ? v + 256 : v;
    };
    return this._write('pcmd', [
      DATA_NO_ACK, this._nextSeq('pcmd'), PROJ_MINIDRONE, CLS_PILOTING,
      CMD_PCMD, 0,
      1, i8(roll), i8(pitch), i8(yaw), i8(gaz),
      0, 0, 0, 0,
    ], quiet);
  }

  /**
   * Continuous PCMD stream, exactly like gobot's StartPcmd(): a frame every
   * 50ms for the whole session, carrying whatever the sticks currently hold.
   *
   * This is not optional. Chrome on Windows does not set MaintainConnection on
   * its GATT session the way bleak does, so WinRT tears the link down after a
   * few seconds of silence. Constant traffic keeps it up — and it is also how
   * the drone expects to be flown.
   */
  _startHeartbeat() {
    if (this._heartbeatRunning) return;
    this._heartbeatRunning = true;

    const loop = async () => {
      // Let the initial ACKs settle before flooding the link (gobot waits too).
      await new Promise((r) => setTimeout(r, 500));
      while (this._heartbeatRunning && this.connected) {
        const { roll, pitch, yaw, gaz } = this.sticks;
        try {
          await this._pcmdFrame(roll, pitch, yaw, gaz, true);
        } catch (err) {
          break; // link is gone; the disconnect handler will clean up
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      this._heartbeatRunning = false;
    };
    loop();
  }

  _stopHeartbeat() {
    this._heartbeatRunning = false;
    this.sticks = { roll: 0, pitch: 0, yaw: 0, gaz: 0 };
  }

  /**
   * Hold a stick position for durationMs, then centre it. The heartbeat does
   * the actual transmitting, so this only has to move the sticks and wait.
   * shouldAbort() lets the runner cut a long move short on STOP.
   */
  async fly(roll, pitch, yaw, gaz, durationMs, shouldAbort = () => false) {
    this.sticks = { roll, pitch, yaw, gaz };
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      if (shouldAbort()) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    this.sticks = { roll: 0, pitch: 0, yaw: 0, gaz: 0 };
  }

  async disconnect() {
    this._stopHeartbeat();
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    this.server = null;
    this.chars = {};
  }
}

export { FLIP_DIRECTION, FLYING_STATE };

"""
ble-doctor.py — check the Mambo's BLE stack without involving a browser.

Runs the same sequence Mambo Blocks does (scan, connect, discover, enable
notifications) straight from Python, so you can tell whether a failure is the
drone, Windows, or the browser.

    pip install bleak
    python tools/ble-doctor.py

Add --fly to also send a flat-trim and read the battery. It never takes off.
"""

import asyncio
import sys

try:
    from bleak import BleakScanner, BleakClient
except ImportError:
    sys.exit("bleak is not installed. Run:  pip install bleak")

NAME_HINTS = ("mambo", "parrot", "swing", "rs_", "airborne")


def uuid(short):
    return f"9a66{short}-0800-9191-11e4-012d1540cb8e"


SERVICES = {
    uuid("fa00"): "command sending",
    uuid("fb00"): "command receiving",
    uuid("fd21"): "ftp",
    uuid("fd51"): "ftp update",
}

REQUIRED_CHARS = {
    uuid("fa0a"): "PCMD (flight control)",
    uuid("fa0b"): "commands (takeoff/land/flip)",
    uuid("fa0c"): "emergency (high priority)",
}

HANDSHAKE = [uuid(s) for s in
             ("fb0e", "fb0f", "fb1b", "fb1c",
              "fd22", "fd23", "fd24", "fd52", "fd53", "fd54")]


def ok(msg):
    print(f"  [ok]   {msg}")


def bad(msg):
    print(f"  [FAIL] {msg}")


async def find_drone(timeout=15.0):
    print(f"\n1. Scanning for {timeout:.0f}s ...")
    devices = await BleakScanner.discover(timeout=timeout, return_adv=True)
    hits = [
        (addr, adv_pair[0], adv_pair[1])
        for addr, adv_pair in devices.items()
        if adv_pair[0].name and any(h in adv_pair[0].name.lower() for h in NAME_HINTS)
    ]
    if not hits:
        bad(f"No Parrot device advertising ({len(devices)} other BLE devices seen).")
        print("\n   The drone is off, out of battery, or wedged.")
        print("   Power-cycle it and make sure the status LED is blinking, then retry.")
        return None
    addr, dev, adv = hits[0]
    ok(f"Found {dev.name} at {addr} (rssi {adv.rssi} dBm)")
    if adv.rssi < -80:
        print("         Signal is weak — move closer.")
    return addr


async def main():
    addr = await find_drone()
    if not addr:
        return 1

    print("\n2. Connecting (5 attempts, same as the app) ...")
    client = BleakClient(addr, timeout=20.0)
    for attempt in range(1, 6):
        try:
            await client.connect()
            if client.is_connected:
                ok(f"Connected on attempt {attempt}")
                break
        except Exception as exc:  # noqa: BLE001 - report whatever the stack says
            bad(f"attempt {attempt}: {type(exc).__name__}: {exc}")
            await asyncio.sleep(0.5 * attempt)
    else:
        print("\n   Never connected. Something else is probably holding the drone —")
        print("   close FreeFlight on every phone/tablet, then power-cycle the drone.")
        return 1

    try:
        print("\n3. Services and characteristics ...")
        found = {}
        for service in client.services:
            label = SERVICES.get(service.uuid.lower())
            if label:
                ok(f"service {service.uuid[4:8]}  ({label})")
            for ch in service.characteristics:
                found[ch.uuid.lower()] = ch

        print()
        missing = False
        for cu, label in REQUIRED_CHARS.items():
            if cu in found:
                ok(f"char {cu[4:8]}  {label}")
            else:
                bad(f"char {cu[4:8]}  {label}  MISSING")
                missing = True
        if missing:
            print("\n   Required characteristics absent — the drone needs a power cycle.")
            return 1

        print("\n4. Handshake (enabling notifications) ...")
        # fd24 and fd54 are the write-only FTP "handling" characteristics; they
        # legitimately have no notify bit, so refusing here is expected.
        write_only = {uuid("fd24"), uuid("fd54")}
        enabled = 0
        for hu in HANDSHAKE:
            if hu not in found:
                continue
            try:
                await client.start_notify(hu, lambda _c, _d: None)
                enabled += 1
            except Exception as exc:  # noqa: BLE001
                if hu in write_only:
                    print(f"  [--]   {hu[4:8]} is write-only (expected)")
                else:
                    bad(f"{hu[4:8]}: {exc}")
        ok(f"{enabled}/8 notification channels enabled")

        if "--fly" in sys.argv:
            print("\n5. Flat trim + state request ...")
            state = {}

            def on_data(_c, data):
                b = bytes(data)
                if len(b) < 7:
                    return
                proj, cls = b[2], b[3]
                cmd = int.from_bytes(b[4:6], "little")
                if proj == 0 and cls == 5 and cmd == 1:
                    state["battery"] = b[6]
                elif proj == 2 and cls == 3 and cmd == 1:
                    state["flying"] = int.from_bytes(b[6:10], "little")

            # State arrives on fb0e (ack'd data), not fb0f — subscribe to both.
            for channel in ("fb0e", "fb0f"):
                await client.start_notify(uuid(channel), on_data)

            # [DATA_WITH_ACK, seq, minidrone, Piloting, FlatTrim u16]
            await client.write_gatt_char(uuid("fa0b"), bytes([4, 1, 2, 0, 0, 0]), response=False)
            ok("flat trim sent")

            # The drone stays silent until asked: common(0)/Common(4)/AllStates(0)
            await client.write_gatt_char(uuid("fa0b"), bytes([4, 2, 0, 4, 0, 0]), response=False)
            ok("AllStates requested")

            await asyncio.sleep(5.0)
            if "battery" in state:
                ok(f"battery reported: {state['battery']}%")
            else:
                bad("no battery notification in 5s")
            if "flying" in state:
                names = ["landed", "takingoff", "hovering", "flying",
                         "landing", "emergency", "rolling", "init"]
                idx = state["flying"]
                ok(f"flying state: {names[idx] if idx < len(names) else idx}")
            else:
                bad("no flying-state notification in 5s")

        print("\nAll checks passed. The drone and this machine's BLE stack are fine.")
        print("If the browser still fails, the problem is browser-side.")
        return 0
    finally:
        await client.disconnect()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

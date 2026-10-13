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


def is_drone(dev):
    return bool(dev.name) and any(h in dev.name.lower() for h in NAME_HINTS)


# How often Windows reports a drone's advertisements. Measured on real
# hardware: a healthy Mambo was heard 14 times in 15s (about once a second),
# while one whose flight system had stopped was heard 3 times in 20s and then
# not at all. Fewer than one every three seconds separates the two cleanly.
SPARSE_SECONDS_PER_ADVERT = 3.0


def sparse(count, seconds):
    return count < seconds / SPARSE_SECONDS_PER_ADVERT


# The advice we give when a drone is visible but its flight system is not.
# Seen in practice: a drone advertising a few times a minute and exposing only
# the two generic Bluetooth services, with every Parrot service gone.
NOT_RESPONDING = """
   The drone is switched on, but its flight system is not responding.
   This is usually a low battery, or the drone has got stuck.

     1. Charge it fully.
     2. Hold the power button until every light goes out, wait 10 seconds,
        then switch it back on.
     3. Wait for the LED to blink normally, then try again.
"""


async def find_drone(timeout=15.0):
    """
    Listen for the drone and count how often it advertises.

    Returns the freshest BLEDevice seen, not just an address: connecting by
    address makes Windows look the drone up again, and a drone that advertises
    only every few seconds is usually not there to be found at that instant.
    That is what produced "device not found" on a drone that was right next
    to the laptop.
    """
    print(f"\n1. Listening for {timeout:.0f}s ...")
    latest = {}
    count = 0
    others = set()

    def on_adv(dev, adv):
        nonlocal count
        if is_drone(dev):
            latest["dev"], latest["rssi"] = dev, adv.rssi
            count += 1
        else:
            others.add(dev.address)

    async with BleakScanner(on_adv):
        await asyncio.sleep(timeout)

    if not latest:
        bad(f"No Parrot drone advertising ({len(others)} other Bluetooth devices seen).")
        print("\n   The drone is off, out of battery, or stuck.")
        print("   Power-cycle it and make sure the status LED is blinking, then retry.")
        return None, 0

    dev = latest["dev"]
    ok(f"Found {dev.name} at {dev.address} (rssi {latest['rssi']} dBm)")
    if latest["rssi"] < -80:
        print("         Signal is weak — move closer.")
    print(f"         Heard {count} advertisement(s) in {timeout:.0f}s.")
    if sparse(count, timeout):
        print("         That is very few. A healthy drone is heard about once a second,")
        print("         so this one is probably low on battery or stuck.")
    return dev, count


async def refind(timeout=10.0):
    """Wait for the next advertisement, so a retry has a fresh device to use."""
    return await BleakScanner.find_device_by_filter(lambda d, _a: is_drone(d), timeout=timeout)


def make_client(dev):
    # Ask Windows for a fresh service list rather than its cached copy, so we
    # report what the drone is exposing now and not what it exposed last time.
    if sys.platform == "win32":
        return BleakClient(dev, timeout=20.0, winrt={"use_cached_services": False})
    return BleakClient(dev, timeout=20.0)


async def main():
    listen = 15.0
    dev, adverts = await find_drone(listen)
    if not dev:
        return 1

    print("\n2. Connecting (5 attempts, same as the app) ...")
    client = None
    for attempt in range(1, 6):
        if attempt > 1:
            fresh = await refind()
            if fresh is None:
                bad(f"attempt {attempt}: drone stopped advertising, nothing to connect to")
                continue
            dev = fresh
        client = make_client(dev)
        try:
            await client.connect()
            if client.is_connected:
                ok(f"Connected on attempt {attempt}")
                break
        except Exception as exc:  # noqa: BLE001 - report whatever the stack says
            bad(f"attempt {attempt}: {type(exc).__name__}: {exc}")
    else:
        print("\n   Never connected.")
        if sparse(adverts, listen):
            print(NOT_RESPONDING)
        else:
            print("   The drone is advertising normally but refusing connections, which")
            print("   usually means something else already holds it. Close FreeFlight on")
            print("   every phone and tablet, then power-cycle the drone.")
        return 1

    try:
        print("\n3. Services and characteristics ...")
        found = {}
        parrot_services = 0
        for service in client.services:
            label = SERVICES.get(service.uuid.lower())
            if label:
                ok(f"service {service.uuid[4:8]}  ({label})")
                parrot_services += 1
            for ch in service.characteristics:
                found[ch.uuid.lower()] = ch

        if parrot_services == 0:
            total = len(list(client.services))
            bad(f"0 of 4 Parrot services present ({total} generic Bluetooth service(s) only)")
            print(NOT_RESPONDING)
            return 1

        print()
        missing = False
        for cu, label in REQUIRED_CHARS.items():
            if cu in found:
                ok(f"char {cu[4:8]}  {label}")
            else:
                bad(f"char {cu[4:8]}  {label}  MISSING")
                missing = True
        if missing:
            print(NOT_RESPONDING)
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

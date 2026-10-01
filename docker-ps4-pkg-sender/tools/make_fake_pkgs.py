#!/usr/bin/env python3
"""Generate fake-but-valid PS4/PS5 PKG files for local UI testing.

Usage: python3 tools/make_fake_pkgs.py [target_dir]

Creates base / patch / DLC packages that the app's CNT+param.sfo parser
can read (title, title id, version, category, icon0.png cover).
"""
import json
import os
import struct
import sys
import zlib


def png_16x16(rgb):
    w = h = 16
    raw = b""
    for _ in range(h):
        raw += b"\x00" + bytes(rgb) * w

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def sfo(entries):
    # entries: list of (key, value_str)
    keys = b""
    data = b""
    meta = []
    for k, v in entries:
        kb = k.encode("ascii") + b"\x00"
        key_off = len(keys)
        keys += kb
        vb = v.encode("utf-8") + b"\x00"
        meta.append((key_off, len(vb), len(data)))
        data += vb
    key_tab = 0x14 + len(entries) * 0x10
    data_tab = key_tab + len(keys)
    out = b"\x00PSF" + struct.pack("<III", 0x0101, key_tab, data_tab) + struct.pack("<I", len(entries))
    for key_off, length, data_off in meta:
        out += struct.pack("<HHIII", key_off, 0x0204, length, length, data_off)
    return out + keys + data


def build_pkg(path, content_id, title, title_id, category, version, kind, rgb):
    """kind: 'ps4' -> param.sfo, 'ps5' -> param.json"""
    names = b"param.sfo\x00icon0.png\x00"
    if kind == "ps5":
        names = b"param.json\x00icon0.png\x00"
    name_off_sfo = 0
    name_off_icon = names.index(b"icon0.png")

    if kind == "ps5":
        meta = json.dumps(
            {
                "contentVersion": version,
                "localizedParameters": {
                    "defaultLanguage": "en-US",
                    "en-US": {"titleName": title},
                },
            }
        ).encode("utf-8")
        entry_meta_id = 0x2000
        entry_meta_name = "param.json"
    else:
        meta = sfo(
            [
                ("TITLE", title),
                ("TITLE_ID", title_id),
                ("CONTENT_ID", content_id),
                ("CATEGORY", category),
                ("APP_VER", version),
                ("VERSION", version),
            ]
        )
        entry_meta_id = 0x1000
        entry_meta_name = "param.sfo"

    icon = png_16x16(rgb)
    count = 3
    table_off = 0x5A0
    name_off = table_off + count * 0x20
    meta_off = name_off + len(names)
    icon_off = meta_off + len(meta)
    total = max(icon_off + len(icon), 0x1000)

    header = bytearray(total)
    header[0:4] = b"\x7fCNT"
    struct.pack_into(">I", header, 0x04, 1)          # pkg type
    struct.pack_into(">I", header, 0x10, count)      # entry count
    struct.pack_into(">I", header, 0x18, table_off)  # table offset
    header[0x40:0x40 + len(content_id)] = content_id.encode("ascii")
    header[0xFE0:0x1000] = os.urandom(32)            # digest

    def entry(eid, noff, doff, dsize):
        return struct.pack(">IIIIIIII", eid, noff, 0, 0, doff, dsize, 0, 0)

    table = (
        entry(0x0200, 0, name_off, len(names))
        + entry(entry_meta_id, name_off_sfo, meta_off, len(meta))
        + entry(0x1200, name_off_icon, icon_off, len(icon))
    )
    header[table_off:table_off + len(table)] = table
    header[name_off:name_off + len(names)] = names
    header[meta_off:meta_off + len(meta)] = meta
    header[icon_off:icon_off + len(icon)] = icon

    with open(path, "wb") as f:
        f.write(header)
    print("wrote", os.path.relpath(path))


def main():
    base_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "files"
    )
    games = [
        {
            "folder": "Astro Bot",
            "title": "ASTRO BOT",
            "tid": "CUSA38478",
            "cid": "UP0082-CUSA38478_00-ASTROBOT000000000",
            "rgb": (58, 120, 255),
            "dlc": ["Astro Bot Art Pack", "Astro Bot Music Pack"],
        },
        {
            "folder": "Need for Speed Unbound ALL DLC",
            "title": "Need for Speed Unbound",
            "tid": "CUSA33284",
            "cid": "UP0006-CUSA33284_00-NFSUNBOUND00000000",
            "rgb": (230, 90, 40),
            "dlc": [
                "Need for Speed Unbound Volume 600",
                "Need for Speed Unbound Volume 700",
                "Need for Speed Unbound Catch Up Pack",
                "Need for Speed Unbound Deluxe Upgrade",
            ],
        },
    ]

    for g in games:
        folder = os.path.join(base_dir, g["folder"])
        os.makedirs(folder, exist_ok=True)
        build_pkg(
            os.path.join(folder, f"{g['cid']}_00-GAMEBASE00000000.pkg"),
            g["cid"], g["title"], g["tid"], "gd", "01.00", "ps4", g["rgb"],
        )
        build_pkg(
            os.path.join(folder, f"{g['cid']}-A0100-V0100_0.pkg"),
            g["cid"], g["title"] + " Patch", g["tid"], "gp", "01.10", "ps4",
            tuple(min(255, c + 40) for c in g["rgb"]),
        )
        for i, dlc in enumerate(g["dlc"]):
            label = f"DLC{i:02d}" + "".join(ch for ch in dlc.upper() if ch.isalnum())[:9]
            cid = f"UP0001-{g['tid']}_00-{label.ljust(16, '0')}"
            build_pkg(
                os.path.join(folder, f"{cid}.pkg"),
                cid, dlc, g["tid"], "ac", "01.00", "ps4",
                tuple(max(0, c - 40) for c in g["rgb"]),
            )
        # one PS5-style pkg (param.json) in its own folder
    ps5_folder = os.path.join(base_dir, "PS5 Demo")
    os.makedirs(ps5_folder, exist_ok=True)
    build_pkg(
        os.path.join(ps5_folder, "UP0001-PPSA00001_00-DEMO0000000000000.pkg"),
        "UP0001-PPSA00001_00-DEMO0000000000000",
        "PS5 Demo Game", "PPSA00001", "", "01.00", "ps5", (120, 200, 90),
    )
    build_pkg(
        os.path.join(ps5_folder, "UP0001-PPSA00001_00-DEMODLC0000000000.pkg"),
        "UP0001-PPSA00001_00-DEMODLC0000000000",
        "PS5 Demo DLC", "PPSA00001", "", "01.00", "ps5", (90, 160, 70),
    )


if __name__ == "__main__":
    main()

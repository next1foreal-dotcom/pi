#!/usr/bin/env python3
"""Verify the exact delivery, optionally unpack to a NEW file. Never applies or executes code."""
import argparse
import hashlib
import lzma
from pathlib import Path

PACKED_SHA = "a7175265c50d08dc90a638035816cad84ebda82edd25012c893f18d725ac57fc"
PATCH_SHA = "1610fa73cee5299c6dfd02e4c19d63ac1550ea3a3903fbed2229e81eb2cb1398"
PATCH_BYTES = 38348

def main():
    p = argparse.ArgumentParser(description=__doc__)
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--verify-only", action="store_true")
    group.add_argument("--output", type=Path)
    a = p.parse_args()
    source = Path(__file__).resolve().with_name("provider-probe.patch.xz")
    data = source.read_bytes()
    if hashlib.sha256(data).hexdigest() != PACKED_SHA:
        raise ValueError("compressed patch digest mismatch")
    patch = lzma.decompress(data, memlimit=128 * 1024 * 1024)
    if len(patch) != PATCH_BYTES or hashlib.sha256(patch).hexdigest() != PATCH_SHA:
        raise ValueError("patch digest mismatch")
    if a.output:
        with a.output.open("xb") as f:
            f.write(patch)
        print(f"Unpacked verified patch: {a.output}; not applied")
    else:
        print("Verified; no files changed")
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, lzma.LZMAError) as e:
        raise SystemExit(f"Refused: {e}")

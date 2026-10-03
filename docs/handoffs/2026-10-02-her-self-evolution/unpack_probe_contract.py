#!/usr/bin/env python3
"""Digest-check and unpack only; never apply or execute the patch."""
import argparse
import hashlib
import lzma
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--verify-only", action="store_true")
    group.add_argument("--output", type=Path)
    args = parser.parse_args()
    raw = (Path(__file__).resolve().parent / "probe-contract.patch.xz").read_bytes()
    if len(raw) != 6584 or hashlib.sha256(raw).hexdigest() != "683eff5833f05323f1dfd4068ab79c5758cd3f680aab53d2909a0c1142a2b651":
        raise SystemExit("compressed patch digest mismatch")
    patch = lzma.decompress(raw, memlimit=32 * 1024 * 1024)
    if len(patch) != 22960 or hashlib.sha256(patch).hexdigest() != "7c4693a7f256bc69cd6f9ea4e902542f753154ddee7e5de017a85e560c85dc56":
        raise SystemExit("patch digest mismatch")
    if args.output:
        with args.output.open("xb") as file:
            file.write(patch)
    print("verified: 22960 bytes; patch NOT applied")


if __name__ == "__main__":
    main()

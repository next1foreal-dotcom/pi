#!/usr/bin/env python3
"""Verify and unpack a candidate patch. Never apply it or modify a Git repository."""
from __future__ import annotations

import argparse
import hashlib
import lzma
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ARCHIVE_SHA256 = "d7c844996bfabfe8128133c36f7590235f4189f2f08c36a23f52f8a610fd3949"
PATCH_SHA256 = "d50aebad8ecd8f5e780b4c339356253b308772f47ba77b096e02b87ea6c81651"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", type=Path, help="New patch file; existing files are never overwritten")
    mode.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    try:
        data = (ROOT / "candidate-cumulative.patch.xz").read_bytes()
        if len(data) != 16872 or hashlib.sha256(data).hexdigest() != ARCHIVE_SHA256:
            raise ValueError("archive integrity mismatch")
        patch = lzma.decompress(data)
        if len(patch) != 74002 or hashlib.sha256(patch).hexdigest() != PATCH_SHA256:
            raise ValueError("patch integrity mismatch")
        if args.output is not None:
            with args.output.open("xb") as stream:
                stream.write(patch)
            print(f"Wrote {args.output}; patch not applied.")
        else:
            print("Archive and patch digests verified; no files changed.")
    except (OSError, ValueError, lzma.LZMAError) as error:
        parser.exit(1, f"Refused: {error}\n")
    print("Candidate only. Complete repository verification and local execution remain required.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Prepare the ExpressLRS build tree for the LoRa2021 (LR2021) prototype.

ExpressLRS builds "Unified" firmware: the pin layout is not compiled in, it is
appended to the binary from `src/hardware/`, which is the separate
ExpressLRS/targets repository. This script:

  1. clones (or updates) ExpressLRS/targets into ExpressLRS/src/hardware
  2. copies our TX/RX layouts into it
  3. merges targets.partial.json into hardware/targets.json
  4. installs our user_defines.txt (regulatory domain, debug flags)

It is idempotent - re-run it after `git pull` in either repo.

    python setup_hardware.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ELRS = HERE / "ExpressLRS"
HARDWARE = ELRS / "src" / "hardware"
TARGETS_REPO = "https://github.com/ExpressLRS/targets.git"


def run(*args: str, cwd: Path | None = None) -> None:
    subprocess.run(args, cwd=cwd, check=True)


def ensure_targets_repo() -> None:
    if (HARDWARE / ".git").exists():
        print(f"-> updating {HARDWARE}")
        run("git", "-C", str(HARDWARE), "pull", "--ff-only")
        return

    if HARDWARE.exists() and any(HARDWARE.iterdir()):
        sys.exit(f"{HARDWARE} exists but is not a git checkout - remove it first")

    print(f"-> cloning ExpressLRS/targets into {HARDWARE}")
    HARDWARE.parent.mkdir(parents=True, exist_ok=True)
    run("git", "clone", "--depth", "1", TARGETS_REPO, str(HARDWARE))


def copy_layouts() -> None:
    for side in ("TX", "RX"):
        src_dir = HERE / "hardware" / side
        dst_dir = HARDWARE / side
        dst_dir.mkdir(parents=True, exist_ok=True)
        for layout in src_dir.glob("*.json"):
            shutil.copy2(layout, dst_dir / layout.name)
            print(f"-> {side}/{layout.name}")


def merge_targets() -> None:
    targets_path = HARDWARE / "targets.json"
    targets = json.loads(targets_path.read_text(encoding="utf-8"))
    partial = json.loads(
        (HERE / "hardware" / "targets.partial.json").read_text(encoding="utf-8")
    )

    for vendor, config in partial.items():
        targets[vendor] = config
        print(f"-> targets.json: {vendor}")

    targets_path.write_text(
        json.dumps(targets, indent=4, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def install_user_defines() -> None:
    src = HERE / "user_defines.txt"
    dst = ELRS / "src" / "user_defines.txt"
    shutil.copy2(src, dst)
    print(f"-> {dst.relative_to(ELRS)}")


def install_envs() -> None:
    """Install our envs and register them in platformio.ini's extra_configs."""
    shutil.copy2(HERE / "lora2021.ini", ELRS / "src" / "targets" / "lora2021.ini")

    pio_ini = ELRS / "src" / "platformio.ini"
    text = pio_ini.read_text(encoding="utf-8")
    entry = "\ttargets/lora2021.ini"
    if entry.strip() in text:
        print("-> targets/lora2021.ini (já registrado)")
        return

    # Append to the extra_configs list, which is the first indented block.
    lines = text.splitlines()
    last = max(i for i, line in enumerate(lines) if line.startswith("\ttargets/"))
    lines.insert(last + 1, entry)
    pio_ini.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("-> targets/lora2021.ini + extra_configs")


def main() -> None:
    if not ELRS.exists():
        sys.exit(
            f"{ELRS} not found - clone it first:\n"
            f"  git clone --depth 1 --branch 4.2/lr2021 "
            f"https://github.com/pkendall64/ExpressLRS.git \"{ELRS}\""
        )

    ensure_targets_repo()
    copy_layouts()
    merge_targets()
    install_user_defines()
    install_envs()

    print("\nready. build with:")
    print(f'  cd "{ELRS / "src"}"')
    print("  pio run -e LoRa2021_TX      # ou LoRa2021_RX")


if __name__ == "__main__":
    main()

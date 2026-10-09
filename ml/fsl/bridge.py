"""Calls the real TypeScript engine (ml/bridge/engine.ts) from Python."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

from . import config as C


def run(task: str, items: list[dict]) -> list[dict]:
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in.json", Path(tmp) / "out.json"
        src.write_text(json.dumps({"task": task, "items": items}))
        subprocess.run(
            [
                "node",
                "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
                "--import",
                str(C.ML_DIR / "bridge" / "register.mjs"),
                str(C.ML_DIR / "bridge" / "engine.ts"),
                str(src),
                str(dst),
            ],
            check=True,
            cwd=C.REPO_DIR,
        )
        return json.loads(dst.read_text())

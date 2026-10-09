"""Runs the offline pipeline in order. Usage, from the repository root:

    ml/.venv/bin/python ml/run_all.py            # every step
    ml/.venv/bin/python ml/run_all.py train      # one or more named steps

Steps: generate, features, train, evaluate, export, check. Each step reads the previous
step's files from ml/work/; export writes ml/export/; check plays the exported seeded cases
through the real engine (tests/ml-export.test.ts).
"""

import subprocess
import sys
import time

from fsl import config as C

from fsl import evaluate, export, features, generate, train

STEPS = {
    "generate": generate.main,
    "features": features.main,
    "train": train.main,
    "evaluate": evaluate.main,
    "export": export.main,
    "check": lambda: subprocess.run(["npx", "vitest", "run", "tests/ml-export.test.ts"], cwd=C.REPO_DIR, check=True),
}

if __name__ == "__main__":
    names = sys.argv[1:] or list(STEPS)
    for name in names:
        started = time.time()
        print(f"\n=== {name} ===")
        STEPS[name]()
        print(f"({time.time() - started:.0f}s)")

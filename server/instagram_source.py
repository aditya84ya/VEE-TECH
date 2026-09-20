"""
VEE-ALERT Instagram Feed Ingestion Source Module (Server Directory Mirror)
"""
import sys
from pathlib import Path

# Add parent directory to sys.path so root implementation or server-local works identically
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from instagram_source import *

if __name__ == "__main__":
    result = run_manual_fetch_pass()
    print(f"[RESULT_JSON]{json.dumps(result)}")

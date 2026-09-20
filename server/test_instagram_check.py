"""
Standalone Test & Verification Script for Instagram Feed Ingestion (Server Directory Mirror)
"""
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from test_instagram_check import main

if __name__ == "__main__":
    main()

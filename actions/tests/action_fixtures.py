"""Constants shared by the action-handler tests."""
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

SEED = Path(__file__).resolve().parents[2] / "seed"
# Monday 12 Oct 2026, 10:00 New York: "Friday" = 16 Oct (the contracts example date).
NOW = datetime(2026, 10, 12, 10, 0, tzinfo=ZoneInfo("America/New_York"))

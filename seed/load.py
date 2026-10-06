"""Thin wrapper: ``python seed/load.py [--reset]`` == ``python -m butler_local.seed [--reset]``."""
from butler_local.seed import main

if __name__ == "__main__":
    main()

"""Entry point: python -m naudiobooker.worker"""

import logging

from ..config import get_settings
from .runner import run_forever

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    run_forever(get_settings())

"""Bounded retries for local atomic replacement; never retry external work."""
import os
import time


def replace(source, destination):
    # Windows observers or antivirus can temporarily deny replacing an open
    # identity/receipt. Preserve the previous file until replacement succeeds.
    for delay in (0.01, 0.02, 0.05, 0.1, 0.2, 0.4, 0.8, None):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if delay is None:
                raise
            time.sleep(delay)

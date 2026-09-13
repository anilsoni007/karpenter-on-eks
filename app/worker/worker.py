import os
import time
import random
import logging
import signal
import sys

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s'
)
log = logging.getLogger(__name__)

POD_NAME = os.environ.get('POD_NAME', 'unknown')
NODE_NAME = os.environ.get('NODE_NAME', 'unknown')
CAPACITY_TYPE = os.environ.get('CAPACITY_TYPE', 'unknown')

# Graceful shutdown handler — critical for Spot interruption handling.
# When Karpenter drains a Spot node, it sends SIGTERM to all pods.
# The worker catches SIGTERM, finishes the current job, and exits cleanly.
# Without this, in-flight jobs would be lost on interruption.
shutdown_requested = False

def handle_sigterm(signum, frame):
    log.info(f"SIGTERM received on pod={POD_NAME} node={NODE_NAME} — finishing current job then exiting")
    global shutdown_requested
    shutdown_requested = True

signal.signal(signal.SIGTERM, handle_sigterm)
signal.signal(signal.SIGINT, handle_sigterm)


def process_job(job_id: int) -> dict:
    """Simulate a batch job with variable CPU and duration."""
    duration = random.uniform(2, 8)
    log.info(f"Starting job={job_id} pod={POD_NAME} node={NODE_NAME} capacity={CAPACITY_TYPE} duration={duration:.1f}s")

    start = time.time()
    # Simulate CPU work
    while time.time() - start < duration:
        _ = sum(i * i for i in range(10_000))

    result = {
        'job_id': job_id,
        'pod': POD_NAME,
        'node': NODE_NAME,
        'capacity_type': CAPACITY_TYPE,
        'duration_s': round(time.time() - start, 2),
        'status': 'completed',
    }
    log.info(f"Completed job={job_id} in {result['duration_s']}s")
    return result


def main():
    log.info(f"Worker starting pod={POD_NAME} node={NODE_NAME} capacity={CAPACITY_TYPE}")
    job_id = 0

    while not shutdown_requested:
        job_id += 1
        try:
            process_job(job_id)
        except Exception as e:
            log.error(f"Job {job_id} failed: {e}")

        # Idle between jobs — simulates realistic batch cadence.
        # During idle, the node appears underutilized and Karpenter
        # may consolidate it. This is intentional for Lab 06.
        idle = random.uniform(5, 15)
        log.info(f"Idle for {idle:.1f}s before next job")

        # Check shutdown flag during idle sleep in small increments
        for _ in range(int(idle * 10)):
            if shutdown_requested:
                break
            time.sleep(0.1)

    log.info(f"Worker exiting cleanly pod={POD_NAME}")
    sys.exit(0)


if __name__ == '__main__':
    main()

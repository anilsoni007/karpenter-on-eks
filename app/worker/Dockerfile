FROM python:3.12-slim

WORKDIR /app

COPY worker.py .

# Run as non-root
RUN useradd -m worker
USER worker

CMD ["python", "-u", "worker.py"]

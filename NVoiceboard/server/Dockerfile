FROM python:3.12-slim

# sherpa-onnx ships manylinux wheels; no build toolchain needed.
RUN pip install --no-cache-dir sherpa-onnx==1.13.4 numpy

WORKDIR /app
COPY bench.py /app/

# Model is bind-mounted at /app/model rather than baked in — it's 632 MB
# and we want to swap exports without rebuilding.
ENV NUM_THREADS=4

CMD ["python", "bench.py"]

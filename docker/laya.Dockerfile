FROM python:3.12-slim

# CUDA 13 wheels support the desktop's Blackwell GPU as well as the server's
# Ampere GPU. Override with cu126 only on older GPUs/drivers, never RTX 50-series.
ARG TORCH_VERSION=2.14.0
ARG TORCH_INDEX=cu130
ARG LAYA_VERSION=0.4.13
RUN python -m pip install --no-cache-dir "torch==${TORCH_VERSION}" --index-url "https://download.pytorch.org/whl/${TORCH_INDEX}" \
    && python -m pip install --no-cache-dir "laya[serve]==${LAYA_VERSION}" \
    && useradd --create-home --uid 10001 laya \
    && mkdir -p /home/laya/.cache/huggingface \
    && chown -R laya:laya /home/laya

ENV HF_HOME=/home/laya/.cache/huggingface \
    TORCH_DISABLE_NATIVE_JIT=1 \
    PYTHONUNBUFFERED=1
USER laya
COPY --chown=laya:laya laya-entrypoint.py /opt/laya-entrypoint.py
EXPOSE 8000
CMD ["python", "/opt/laya-entrypoint.py"]

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1

WORKDIR /app

# Build argument for optional MuJoCo support
ARG INSTALL_MUJOCO=false

COPY requirements.txt ./

# Install base requirements
RUN pip install --no-cache-dir -r requirements.txt

# Optionally install MuJoCo
RUN if [ "${INSTALL_MUJOCO}" = "true" ]; then \
  echo "Installing MuJoCo..." && \
  pip install --no-cache-dir mujoco>=0.3.1 dm-control>=1.0.20 numpy>=1.24.0; \
  else \
  echo "MuJoCo not installed (INSTALL_MUJOCO=${INSTALL_MUJOCO}). Physics engine will use lightweight mode."; \
  fi

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

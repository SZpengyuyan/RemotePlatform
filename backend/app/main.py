from __future__ import annotations

import asyncio
import random
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Remote Platform Minimal Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_JOINTS = [0.3, -0.5, 0.7, 0.2]


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.websocket("/ws")
async def ws_telemetry(websocket: WebSocket) -> None:
    await websocket.accept()

    joints = DEFAULT_JOINTS.copy()
    seq = 0
    delay_ms = 80.0
    jitter_ms = 12.0
    loss_rate = 0.01
    bandwidth_kbps = 4096.0

    async def receiver() -> None:
        nonlocal joints
        while True:
            message = await websocket.receive_json()
            msg_type = message.get("type")
            payload = message.get("payload", {})

            if msg_type == "robot_joint_control":
                targets = payload.get("target_positions", [])
                if isinstance(targets, list) and len(targets) >= 4:
                    joints = [float(targets[0]), float(targets[1]), float(targets[2]), float(targets[3])]

            if msg_type == "robot_reset":
                joints = DEFAULT_JOINTS.copy()

    async def sender() -> None:
        nonlocal seq, delay_ms, jitter_ms, loss_rate, bandwidth_kbps
        while True:
            delay_ms = max(8.0, min(260.0, delay_ms + random.uniform(-8, 8)))
            jitter_ms = max(0.5, min(60.0, jitter_ms + random.uniform(-2.5, 2.5)))
            loss_rate = max(0.0, min(0.2, loss_rate + random.uniform(-0.004, 0.004)))
            bandwidth_kbps = max(256.0, min(20000.0, bandwidth_kbps + random.uniform(-500, 500)))

            await websocket.send_json(
                {
                    "type": "telemetry",
                    "seq": seq,
                    "server_ts": time.time(),
                    "network_stats": {
                        "avg_total_delay_ms": round(delay_ms, 2),
                        "observed_loss_rate": round(loss_rate, 4),
                    },
                    "network_config": {
                        "jitter_ms": round(jitter_ms, 2),
                        "bandwidth_kbps": round(bandwidth_kbps, 1),
                    },
                    "simulation_status": {
                        "joint_positions": joints,
                    },
                }
            )
            seq += 1
            await asyncio.sleep(0.2)

    receiver_task = asyncio.create_task(receiver())
    sender_task = asyncio.create_task(sender())

    try:
        await asyncio.gather(receiver_task, sender_task)
    except WebSocketDisconnect:
        pass
    finally:
        receiver_task.cancel()
        sender_task.cancel()

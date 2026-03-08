from __future__ import annotations

import asyncio
import json
import random
import time
from dataclasses import dataclass

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


@dataclass
class SimNetwork:
    delay_ms: float = 60.0
    jitter_ms: float = 8.0
    loss_rate: float = 0.01
    bandwidth_kbps: float = 4096.0
    queue_penalty_ms: float = 120.0


@dataclass
class QueuedCommand:
    apply_ts: float
    seq: int
    cmd_seq: int
    client_timestamp: float
    target_positions: list[float]
    simulated_delay_ms: float


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.websocket("/ws")
async def ws_telemetry(websocket: WebSocket) -> None:
    await websocket.accept()

    joints = DEFAULT_JOINTS.copy()
    telemetry_seq = 0
    network = SimNetwork()
    queue: list[QueuedCommand] = []
    queue_seq = 0

    cmd_total = 0
    cmd_dropped = 0
    delay_sum_ms = 0.0
    delay_samples = 0

    async def receiver() -> None:
        nonlocal joints, queue_seq, cmd_total, cmd_dropped
        while True:
            message = await websocket.receive_json()
            msg_type = message.get("type")
            payload = message.get("payload", {})

            if msg_type == "robot_joint_control":
                cmd_total += 1
                targets = payload.get("target_positions", [])
                cmd_seq = int(message.get("cmd_seq", 0))
                client_timestamp = float(message.get("client_timestamp", 0))

                if isinstance(targets, list) and len(targets) >= 4:
                    if random.random() < network.loss_rate:
                        cmd_dropped += 1
                        continue

                    safe_targets = [
                        float(targets[0]),
                        float(targets[1]),
                        float(targets[2]),
                        float(targets[3]),
                    ]

                    payload_bytes = len(json.dumps(message, ensure_ascii=True).encode("utf-8"))
                    serialization_delay_ms = (payload_bytes * 8.0) / max(1.0, network.bandwidth_kbps)
                    jitter_offset = random.uniform(-network.jitter_ms, network.jitter_ms)
                    base = max(0.0, network.delay_ms + jitter_offset)

                    # When queue grows beyond 5 commands, add a strong congestion penalty.
                    pending = len(queue)
                    congestion_penalty_ms = 0.0
                    if pending > 5:
                        overflow = pending - 5
                        congestion_penalty_ms = (overflow * overflow) * network.queue_penalty_ms

                    total_delay_ms = base + serialization_delay_ms + congestion_penalty_ms

                    queue_seq += 1
                    queue.append(
                        QueuedCommand(
                            apply_ts=time.time() + total_delay_ms / 1000.0,
                            seq=queue_seq,
                            cmd_seq=cmd_seq,
                            client_timestamp=client_timestamp,
                            target_positions=safe_targets,
                            simulated_delay_ms=total_delay_ms,
                        )
                    )
                    queue.sort(key=lambda item: (item.apply_ts, item.seq))

            if msg_type == "robot_reset":
                joints = DEFAULT_JOINTS.copy()

            if msg_type == "network_profile":
                network.delay_ms = max(0.0, float(payload.get("delay_ms", network.delay_ms)))
                network.jitter_ms = max(0.0, float(payload.get("jitter_ms", network.jitter_ms)))
                network.loss_rate = max(0.0, min(0.9, float(payload.get("loss_rate", network.loss_rate))) )
                network.bandwidth_kbps = max(64.0, float(payload.get("bandwidth_kbps", network.bandwidth_kbps)))
                network.queue_penalty_ms = max(0.0, float(payload.get("queue_penalty_ms", network.queue_penalty_ms)))

    async def command_processor() -> None:
        nonlocal joints, delay_sum_ms, delay_samples
        while True:
            if not queue:
                await asyncio.sleep(0.005)
                continue

            head = queue[0]
            wait = head.apply_ts - time.time()
            if wait > 0:
                await asyncio.sleep(min(wait, 0.02))
                continue

            cmd = queue.pop(0)
            joints = cmd.target_positions
            delay_sum_ms += cmd.simulated_delay_ms
            delay_samples += 1

            await websocket.send_json(
                {
                    "type": "ack",
                    "cmd_seq": cmd.cmd_seq,
                    "client_timestamp": cmd.client_timestamp,
                    "server_recv_ts": cmd.apply_ts - cmd.simulated_delay_ms / 1000.0,
                    "server_apply_ts": time.time(),
                    "simulated_delay_ms": round(cmd.simulated_delay_ms, 2),
                }
            )

    async def sender() -> None:
        nonlocal telemetry_seq
        while True:
            observed_loss = (cmd_dropped / cmd_total) if cmd_total > 0 else 0.0
            avg_delay = (delay_sum_ms / delay_samples) if delay_samples > 0 else 0.0

            await websocket.send_json(
                {
                    "type": "telemetry",
                    "seq": telemetry_seq,
                    "server_ts": time.time(),
                    "network_stats": {
                        "avg_total_delay_ms": round(avg_delay, 2),
                        "observed_loss_rate": round(observed_loss, 4),
                    },
                    "network_config": {
                        "delay_ms": round(network.delay_ms, 2),
                        "jitter_ms": round(network.jitter_ms, 2),
                        "loss_rate": round(network.loss_rate, 4),
                        "bandwidth_kbps": round(network.bandwidth_kbps, 1),
                    },
                    "queue": {"pending": len(queue)},
                    "simulation_status": {
                        "joint_positions": joints,
                    },
                }
            )
            telemetry_seq += 1
            await asyncio.sleep(0.2)

    receiver_task = asyncio.create_task(receiver())
    processor_task = asyncio.create_task(command_processor())
    sender_task = asyncio.create_task(sender())

    try:
        await asyncio.gather(receiver_task, processor_task, sender_task)
    except WebSocketDisconnect:
        pass
    finally:
        receiver_task.cancel()
        processor_task.cancel()
        sender_task.cancel()

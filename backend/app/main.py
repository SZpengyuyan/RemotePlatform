from __future__ import annotations

import asyncio
import json
import math
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


def clamp_joint_rad(value: float) -> float:
    return max(-2.6, min(2.6, value))


def solve_simple_ik(
    target_x: float,
    target_y: float,
    target_z: float,
    wrist_pitch_deg: float,
) -> list[float]:
    """Solve a lightweight IK target for the demo arm and return 4 joint angles."""
    # Geometry values align with current Arm3D segment lengths in the frontend.
    shoulder_height = 0.8
    l1 = 1.4
    l2 = 1.2
    l3 = 0.48

    base_yaw = math.atan2(target_x, target_z)
    radial = max(0.05, math.hypot(target_x, target_z))
    height = target_y - shoulder_height

    wrist_pitch = math.radians(wrist_pitch_deg)
    wx = radial - l3 * math.cos(wrist_pitch)
    wy = height - l3 * math.sin(wrist_pitch)

    reach = max(0.05, math.hypot(wx, wy))
    reach = min(reach, (l1 + l2) - 1e-6)

    cos_elbow = (reach * reach - l1 * l1 - l2 * l2) / (2 * l1 * l2)
    cos_elbow = max(-1.0, min(1.0, cos_elbow))
    elbow = -math.acos(cos_elbow)

    shoulder = math.atan2(wy, wx) - math.atan2(l2 * math.sin(elbow), l1 + l2 * math.cos(elbow))
    wrist = wrist_pitch - shoulder - elbow

    return [
        clamp_joint_rad(base_yaw),
        clamp_joint_rad(shoulder),
        clamp_joint_rad(elbow),
        clamp_joint_rad(wrist),
    ]


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
    steps: int
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
    motion_waypoints: list[list[float]] = []
    queue_seq = 0

    cmd_total = 0
    cmd_dropped = 0
    delay_sum_ms = 0.0
    delay_samples = 0

    def enqueue_control_command(
        message: dict,
        cmd_seq: int,
        client_timestamp: float,
        target_positions: list[float],
        steps: int,
    ) -> bool:
        nonlocal queue_seq, cmd_total, cmd_dropped
        cmd_total += 1

        if random.random() < network.loss_rate:
            cmd_dropped += 1
            return False

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
                target_positions=target_positions,
                steps=steps,
                simulated_delay_ms=total_delay_ms,
            )
        )
        queue.sort(key=lambda item: (item.apply_ts, item.seq))
        return True

    async def receiver() -> None:
        nonlocal joints
        while True:
            message = await websocket.receive_json()
            msg_type = message.get("type")
            payload = message.get("payload", {})

            if msg_type == "robot_joint_control":
                targets = payload.get("target_positions", [])
                requested_steps = int(payload.get("steps", 8))
                steps = max(1, min(60, requested_steps))
                cmd_seq = int(message.get("cmd_seq", 0))
                client_timestamp = float(message.get("client_timestamp", 0))

                if isinstance(targets, list) and len(targets) >= 4:
                    safe_targets = [
                        clamp_joint_rad(float(targets[0])),
                        clamp_joint_rad(float(targets[1])),
                        clamp_joint_rad(float(targets[2])),
                        clamp_joint_rad(float(targets[3])),
                    ]
                    enqueue_control_command(
                        message=message,
                        cmd_seq=cmd_seq,
                        client_timestamp=client_timestamp,
                        target_positions=safe_targets,
                        steps=steps,
                    )

            if msg_type == "robot_ee_control":
                target_ee = payload.get("target_ee", {})
                requested_steps = int(payload.get("steps", 12))
                steps = max(1, min(60, requested_steps))
                wrist_pitch_deg = float(payload.get("wrist_pitch_deg", -25.0))
                cmd_seq = int(message.get("cmd_seq", 0))
                client_timestamp = float(message.get("client_timestamp", 0))

                if isinstance(target_ee, dict):
                    target_x = float(target_ee.get("x", 0.0))
                    target_y = float(target_ee.get("y", 1.8))
                    target_z = float(target_ee.get("z", 1.6))
                    ik_joints = solve_simple_ik(target_x, target_y, target_z, wrist_pitch_deg)
                    enqueue_control_command(
                        message=message,
                        cmd_seq=cmd_seq,
                        client_timestamp=client_timestamp,
                        target_positions=ik_joints,
                        steps=steps,
                    )

            if msg_type == "robot_reset":
                joints = DEFAULT_JOINTS.copy()
                motion_waypoints.clear()

            if msg_type == "network_profile":
                network.delay_ms = max(0.0, float(payload.get("delay_ms", network.delay_ms)))
                network.jitter_ms = max(0.0, float(payload.get("jitter_ms", network.jitter_ms)))
                network.loss_rate = max(0.0, min(0.9, float(payload.get("loss_rate", network.loss_rate))))
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
            start = motion_waypoints[-1] if motion_waypoints else joints.copy()
            steps = max(1, cmd.steps)
            for i in range(1, steps + 1):
                t = i / steps
                waypoint = [
                    (start[0] * (1 - t)) + (cmd.target_positions[0] * t),
                    (start[1] * (1 - t)) + (cmd.target_positions[1] * t),
                    (start[2] * (1 - t)) + (cmd.target_positions[2] * t),
                    (start[3] * (1 - t)) + (cmd.target_positions[3] * t),
                ]
                motion_waypoints.append(waypoint)

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
                    "trajectory_steps": steps,
                }
            )

    async def motion_stepper() -> None:
        nonlocal joints
        while True:
            if motion_waypoints:
                joints = motion_waypoints.pop(0)
            await asyncio.sleep(0.02)

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
                    "queue": {
                        "pending": len(queue),
                        "waypoint_pending": len(motion_waypoints),
                    },
                    "simulation_status": {
                        "joint_positions": joints,
                    },
                }
            )
            telemetry_seq += 1
            await asyncio.sleep(0.1)

    receiver_task = asyncio.create_task(receiver())
    processor_task = asyncio.create_task(command_processor())
    motion_stepper_task = asyncio.create_task(motion_stepper())
    sender_task = asyncio.create_task(sender())

    try:
        await asyncio.gather(receiver_task, processor_task, motion_stepper_task, sender_task)
    except WebSocketDisconnect:
        pass
    finally:
        receiver_task.cancel()
        processor_task.cancel()
        motion_stepper_task.cancel()
        sender_task.cancel()

from __future__ import annotations

import asyncio
import csv
import json
import io
import math
import os
import random
import struct
import time
from collections import deque
from dataclasses import dataclass

from fastapi import FastAPI, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

try:
    from app.wireless.wireless_module import AdvancedWirelessLink as ExternalAdvancedWirelessLink
    from app.wireless.wireless_module import WirelessLink as ExternalWirelessLink
    EXTERNAL_WIRELESS_AVAILABLE = True
    EXTERNAL_WIRELESS_IMPORT_ERROR = ""
except Exception as exc:
    ExternalAdvancedWirelessLink = None
    ExternalWirelessLink = None
    EXTERNAL_WIRELESS_AVAILABLE = False
    EXTERNAL_WIRELESS_IMPORT_ERROR = str(exc)

# Physics engine selection
PHYSICS_ENGINE = os.getenv("PHYSICS_ENGINE", "lightweight").lower()
WIRELESS_ENGINE = os.getenv("WIRELESS_ENGINE", "external").lower()
MUJOCO_AVAILABLE = False

try:
    import mujoco as mj
    import mujoco.viewer
    MUJOCO_AVAILABLE = True
except ImportError:
    pass

app = FastAPI(title="Remote Platform Minimal Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_JOINTS = [0.3, -0.5, 0.7, 0.2]
EXPERIMENT_HISTORY_MAXLEN = 5000
EXPERIMENT_HISTORY: deque[dict] = deque(maxlen=EXPERIMENT_HISTORY_MAXLEN)


# Physics Engine Abstraction
class PhysicsEngine:
    """Base class for physics simulation."""
    
    def get_name(self) -> str:
        raise NotImplementedError
    
    def initialize(self) -> None:
        """Initialize physics engine resources."""
        pass
    
    def cleanup(self) -> None:
        """Clean up resources."""
        pass
    
    def step(self, joints: list[float], target: list[float], steps: int) -> list[list[float]]:
        """Generate waypoints from current to target. Returns list of interpolated positions."""
        raise NotImplementedError

    def runtime_status(self) -> dict:
        return {
            "active": self.get_name(),
            "using_internal_fallback": False,
            "model_loaded": False,
            "fallback_reason": "",
        }

    def metrics(self, target_positions: list[float] | None = None) -> dict:
        return {
            "tracking_error_rad": 0.0,
            "qvel_norm": 0.0,
        }


class LightweightPhysicsEngine(PhysicsEngine):
    """Simple linear interpolation without physics simulation."""
    
    def get_name(self) -> str:
        return "lightweight"
    
    def step(self, joints: list[float], target: list[float], steps: int) -> list[list[float]]:
        """Linear interpolation between joints and target."""
        steps = max(1, steps)
        waypoints = []
        for i in range(1, steps + 1):
            t = i / steps
            waypoint = [
                (joints[j] * (1 - t)) + (target[j] * t)
                for j in range(len(target))
            ]
            waypoints.append(waypoint)
        return waypoints

    def runtime_status(self) -> dict:
        return {
            "active": self.get_name(),
            "using_internal_fallback": False,
            "model_loaded": False,
            "fallback_reason": "",
        }


class MuJoCoPhysicsEngine(PhysicsEngine):
    """MuJoCo-based physics simulation."""
    
    def __init__(self):
        self.model = None
        self.data = None
        self.model_loaded = False
        self.fallback_reason = ""
        self.loaded_model_name = ""
    
    def get_name(self) -> str:
        return "mujoco"
    
    def initialize(self) -> None:
        """Load MuJoCo model from app models directory."""
        if not MUJOCO_AVAILABLE:
            self.fallback_reason = "mujoco_package_unavailable"
            return
        
        try:
            model_dir = os.path.join(os.getcwd(), "app", "models")
            candidate_paths = [
                os.path.join(model_dir, "ur5e.xml"),
                os.path.join(model_dir, "arm4_demo.xml"),
            ]
            for model_path in candidate_paths:
                if os.path.exists(model_path):
                    self.model = mj.MjModel.from_xml_path(model_path)
                    self.data = mj.MjData(self.model)
                    self.model_loaded = True
                    self.loaded_model_name = os.path.basename(model_path)
                    break

            if not self.model_loaded:
                self.fallback_reason = "mujoco_model_missing"
        except Exception:
            self.fallback_reason = "mujoco_model_load_failed"

    def _apply_joint_state(self, joints: list[float]) -> None:
        if not self.model or not self.data:
            return
        qn = min(len(joints), self.model.nq)
        vn = min(len(joints), self.model.nv)
        for i in range(qn):
            self.data.qpos[i] = joints[i]
        for i in range(vn):
            self.data.qvel[i] = 0.0
    
    def step(self, joints: list[float], target: list[float], steps: int) -> list[list[float]]:
        """
        If MuJoCo model is available, simulate motion; otherwise fall back to linear interpolation.
        """
        if not self.model or not self.data:
            # Fallback to lightweight if model unavailable
            engine = LightweightPhysicsEngine()
            return engine.step(joints, target, steps)
        
        ctrl_n = min(self.model.nu, len(target))
        qn = min(self.model.nq, len(target))
        if ctrl_n <= 0 or qn <= 0:
            self.fallback_reason = "mujoco_invalid_model_dof"
            engine = LightweightPhysicsEngine()
            return engine.step(joints, target, steps)

        self._apply_joint_state(joints)

        for i in range(ctrl_n):
            self.data.ctrl[i] = target[i]

        outer_steps = max(1, steps)
        # In MuJoCo mode we run a longer physical horizon to make inertia clearly visible.
        dt = float(self.model.opt.timestep)
        horizon_sec = max(0.45, outer_steps * 0.055)
        total_substeps = max(outer_steps, int(horizon_sec / max(1e-4, dt)))
        sample_every = max(1, total_substeps // outer_steps)
        waypoints: list[list[float]] = []
        for i in range(total_substeps):
            mj.mj_step(self.model, self.data)
            if (i + 1) % sample_every == 0:
                waypoint = [float(self.data.qpos[iq]) for iq in range(qn)]
                if qn < 4:
                    waypoint.extend([0.0] * (4 - qn))
                waypoints.append(waypoint[:4])

        if not waypoints:
            waypoint = [float(self.data.qpos[iq]) for iq in range(qn)]
            if qn < 4:
                waypoint.extend([0.0] * (4 - qn))
            waypoints.append(waypoint[:4])

        if len(waypoints) > outer_steps:
            waypoints = waypoints[-outer_steps:]
        elif len(waypoints) < outer_steps:
            last = waypoints[-1]
            waypoints.extend([last.copy() for _ in range(outer_steps - len(waypoints))])

        return waypoints

    def metrics(self, target_positions: list[float] | None = None) -> dict:
        if not self.model or not self.data:
            return {
                "tracking_error_rad": 0.0,
                "qvel_norm": 0.0,
            }

        nq = min(self.model.nq, 4)
        nv = min(self.model.nv, 4)
        qpos = [float(self.data.qpos[i]) for i in range(nq)]
        qvel = [float(self.data.qvel[i]) for i in range(nv)]
        qvel_norm = math.sqrt(sum(v * v for v in qvel))

        tracking_error = 0.0
        if target_positions:
            m = min(len(target_positions), len(qpos))
            if m > 0:
                tracking_error = math.sqrt(
                    sum((qpos[i] - float(target_positions[i])) ** 2 for i in range(m)) / m
                )

        return {
            "tracking_error_rad": round(tracking_error, 4),
            "qvel_norm": round(qvel_norm, 4),
        }

    def runtime_status(self) -> dict:
        using_internal_fallback = not self.model_loaded
        return {
            "active": self.get_name(),
            "using_internal_fallback": using_internal_fallback,
            "model_loaded": self.model_loaded,
            "fallback_reason": self.fallback_reason,
            "model_name": self.loaded_model_name,
        }


def get_physics_engine() -> PhysicsEngine:
    """Factory function to select the appropriate physics engine."""
    if PHYSICS_ENGINE == "mujoco" and MUJOCO_AVAILABLE:
        engine = MuJoCoPhysicsEngine()
        engine.initialize()
        return engine
    else:
        if PHYSICS_ENGINE == "mujoco" and not MUJOCO_AVAILABLE:
            print("⚠️  MuJoCo requested but not available. Falling back to lightweight mode.")
        return LightweightPhysicsEngine()



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
class SimWireless:
    mode: str = "basic_awgn"
    ebno_db: float = 10.0
    force_sensor_enabled: bool = False
    engine_requested: str = WIRELESS_ENGINE


@dataclass
class QueuedCommand:
    apply_ts: float
    seq: int
    cmd_seq: int
    client_timestamp: float
    target_positions: list[float]
    steps: int
    simulated_delay_ms: float


def simulate_wireless_transmission(
    target_positions: list[float],
    mode: str,
    ebno_db: float,
) -> tuple[list[float], float, float, float]:
    """Return transmitted target, BER, processing delay(ms), and mean abs trajectory error."""
    safe_mode = mode if mode in ("basic_awgn", "advanced_cdl_ofdm") else "basic_awgn"
    ebno = max(-2.0, min(30.0, float(ebno_db)))
    snr_linear = 10 ** (ebno / 10.0)

    # Approximate uncoded BER baseline (BPSK-like), then apply mode-specific coding gain.
    raw_ber = 0.5 * math.erfc(math.sqrt(max(snr_linear, 1e-9)))
    if safe_mode == "advanced_cdl_ofdm":
        bit_flip_prob = max(0.00001, min(0.2, raw_ber * 0.35 + 0.00005))
        processing_delay_ms = random.uniform(10.0, 18.0) + max(0.0, (12.0 - ebno) * 0.7)
    else:
        bit_flip_prob = max(0.00002, min(0.25, raw_ber * 0.85 + 0.0002))
        processing_delay_ms = random.uniform(4.0, 10.0) + max(0.0, (10.0 - ebno) * 0.5)

    # Encode 4 joint angles as float32 bitstream (128 bits total).
    bits: list[int] = []
    for value in target_positions:
        packed = struct.pack("!f", float(value))
        as_int = int.from_bytes(packed, byteorder="big", signed=False)
        for shift in range(31, -1, -1):
            bits.append((as_int >> shift) & 1)

    if not bits:
        return [], bit_flip_prob, processing_delay_ms, 0.0

    bits_hat: list[int] = []
    error_bits = 0
    for b in bits:
        flipped = b
        if random.random() < bit_flip_prob:
            flipped = 1 - b
            error_bits += 1
        bits_hat.append(flipped)

    # Decode bitstream back to float32 joint angles.
    transmitted: list[float] = []
    for idx in range(0, len(bits_hat), 32):
        chunk = bits_hat[idx:idx + 32]
        if len(chunk) < 32:
            break
        as_int = 0
        for bit in chunk:
            as_int = (as_int << 1) | bit
        raw = as_int.to_bytes(4, byteorder="big", signed=False)
        decoded = struct.unpack("!f", raw)[0]
        if not math.isfinite(decoded):
            decoded = 0.0
        transmitted.append(clamp_joint_rad(float(decoded)))

    if len(transmitted) < len(target_positions):
        transmitted.extend(float(v) for v in target_positions[len(transmitted):])

    ber = error_bits / len(bits)
    trajectory_error_mean = sum(abs(transmitted[i] - float(target_positions[i])) for i in range(len(target_positions))) / len(target_positions)
    return transmitted, ber, processing_delay_ms, trajectory_error_mean


class WirelessEngine:
    def get_name(self) -> str:
        raise NotImplementedError

    def transmit(
        self,
        target_positions: list[float],
        mode: str,
        ebno_db: float,
    ) -> tuple[list[float], float, float, float]:
        raise NotImplementedError

    def runtime_status(self) -> dict:
        return {
            "active": self.get_name(),
            "using_internal_fallback": False,
            "fallback_reason": "",
            "external_module_available": EXTERNAL_WIRELESS_AVAILABLE,
        }


class InternalWirelessEngine(WirelessEngine):
    def __init__(self, reason: str = ""):
        self.fallback_reason = reason

    def get_name(self) -> str:
        return "internal"

    def transmit(
        self,
        target_positions: list[float],
        mode: str,
        ebno_db: float,
    ) -> tuple[list[float], float, float, float]:
        return simulate_wireless_transmission(target_positions, mode, ebno_db)

    def runtime_status(self) -> dict:
        return {
            "active": self.get_name(),
            "using_internal_fallback": False,
            "fallback_reason": self.fallback_reason,
            "external_module_available": EXTERNAL_WIRELESS_AVAILABLE,
        }


class ExternalModuleWirelessEngine(WirelessEngine):
    def __init__(self):
        if not EXTERNAL_WIRELESS_AVAILABLE or ExternalWirelessLink is None or ExternalAdvancedWirelessLink is None:
            raise RuntimeError(f"external_wireless_unavailable: {EXTERNAL_WIRELESS_IMPORT_ERROR}")

        self.basic_link = ExternalWirelessLink(coderate=0.5)
        self.advanced_link = ExternalAdvancedWirelessLink(cdl_model="C", bs_antennas=4)
        self._tail_joints = [0.0, 0.0]
        self._using_internal_fallback = False
        self._fallback_reason = ""

    def get_name(self) -> str:
        return "external"

    def _to_six_axis(self, target_positions: list[float]) -> list[float]:
        base = [float(v) for v in target_positions[:4]]
        if len(base) < 4:
            base.extend([0.0] * (4 - len(base)))
        base.extend(self._tail_joints)
        return base[:6]

    def transmit(
        self,
        target_positions: list[float],
        mode: str,
        ebno_db: float,
    ) -> tuple[list[float], float, float, float]:
        link = self.advanced_link if mode == "advanced_cdl_ofdm" else self.basic_link
        six_axis = self._to_six_axis(target_positions)

        try:
            joint_hat, ber, delay_s = link.transmit(six_axis, ebno_db=ebno_db, distance_km=10.0)
            joint_hat = [clamp_joint_rad(float(v)) for v in joint_hat]
            if len(joint_hat) >= 6:
                self._tail_joints = [joint_hat[4], joint_hat[5]]

            transmitted = []
            for idx, original in enumerate(target_positions):
                if idx < len(joint_hat):
                    transmitted.append(joint_hat[idx])
                else:
                    transmitted.append(float(original))

            if not transmitted:
                transmitted = target_positions.copy()

            m = min(len(transmitted), len(target_positions))
            trajectory_error_mean = (
                sum(abs(transmitted[i] - float(target_positions[i])) for i in range(m)) / m if m > 0 else 0.0
            )

            self._using_internal_fallback = False
            self._fallback_reason = ""
            return transmitted, float(ber), float(delay_s) * 1000.0, float(trajectory_error_mean)
        except Exception as exc:
            self._using_internal_fallback = True
            self._fallback_reason = f"external_runtime_error:{exc}"
            return simulate_wireless_transmission(target_positions, mode, ebno_db)

    def runtime_status(self) -> dict:
        return {
            "active": self.get_name(),
            "using_internal_fallback": self._using_internal_fallback,
            "fallback_reason": self._fallback_reason,
            "external_module_available": EXTERNAL_WIRELESS_AVAILABLE,
        }


def get_wireless_engine(requested: str) -> WirelessEngine:
    requested_normalized = (requested or "").strip().lower()
    if requested_normalized in ("external", "module", "partner"):
        if EXTERNAL_WIRELESS_AVAILABLE:
            return ExternalModuleWirelessEngine()
        return InternalWirelessEngine(reason=f"external_import_failed:{EXTERNAL_WIRELESS_IMPORT_ERROR}")

    return InternalWirelessEngine()


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/api/v1/experiments/export/csv")
async def export_experiment_csv() -> Response:
    """Export recent telemetry samples as CSV for experiment analysis."""
    fieldnames = [
        "sample_ts",
        "seq",
        "average_ber",
        "last_ber",
        "wireless_delay_ms",
        "total_wireless_delay_ms",
        "trajectory_error_mean",
        "transmission_count",
        "total_run_time_s",
        "queue_pending",
        "wireless_mode",
        "ebno_db",
        "physics_mode",
        "force_sensor_enabled",
        "active_joint_1",
        "active_joint_2",
        "active_joint_3",
        "active_joint_4",
    ]

    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fieldnames)
    writer.writeheader()
    for row in list(EXPERIMENT_HISTORY):
        writer.writerow(row)

    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=experiment_metrics.csv"},
    )


@app.websocket("/ws")
async def ws_telemetry(websocket: WebSocket) -> None:
    await websocket.accept()

    joints = DEFAULT_JOINTS.copy()
    telemetry_seq = 0
    network = SimNetwork()
    wireless = SimWireless()
    wireless_engine = get_wireless_engine(wireless.engine_requested)
    queue: list[QueuedCommand] = []
    motion_waypoints: list[list[float]] = []
    queue_seq = 0
    run_start_ts = time.time()
    
    # Initialize physics engine
    physics_engine = get_physics_engine()
    print(f"✓ Physics engine initialized: {physics_engine.get_name()}")
    physics_requested = PHYSICS_ENGINE
    print(f"✓ Wireless engine initialized: {wireless_engine.get_name()}")

    cmd_total = 0
    cmd_dropped = 0
    delay_sum_ms = 0.0
    delay_samples = 0
    latest_target_positions: list[float] | None = None
    wireless_transmissions = 0
    ber_sum = 0.0
    last_ber = 0.0
    total_wireless_delay_ms = 0.0
    last_wireless_delay_ms = 0.0
    trajectory_error_sum = 0.0
    last_trajectory_error_mean = 0.0

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
        nonlocal joints, wireless_engine
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

            if msg_type == "wireless_config":
                requested_mode = str(payload.get("mode", wireless.mode))
                wireless.mode = requested_mode if requested_mode in ("basic_awgn", "advanced_cdl_ofdm") else "basic_awgn"
                wireless.ebno_db = max(-2.0, min(30.0, float(payload.get("ebno_db", wireless.ebno_db))))
                wireless.force_sensor_enabled = bool(payload.get("force_sensor_enabled", wireless.force_sensor_enabled))
                requested_engine = str(payload.get("engine", wireless.engine_requested)).strip().lower()
                if requested_engine in ("internal", "external", "module", "partner"):
                    if requested_engine != wireless.engine_requested:
                        wireless.engine_requested = requested_engine
                        wireless_engine = get_wireless_engine(wireless.engine_requested)

    async def command_processor() -> None:
        nonlocal joints, delay_sum_ms, delay_samples, latest_target_positions
        nonlocal wireless_transmissions, ber_sum, last_ber
        nonlocal total_wireless_delay_ms, last_wireless_delay_ms
        nonlocal trajectory_error_sum, last_trajectory_error_mean
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
            transmitted_target, ber, wireless_delay_ms, trajectory_error_mean = wireless_engine.transmit(
                target_positions=cmd.target_positions,
                mode=wireless.mode,
                ebno_db=wireless.ebno_db,
            )
            latest_target_positions = transmitted_target
            start = motion_waypoints[-1] if motion_waypoints else joints.copy()
            steps = max(1, cmd.steps)
            
            # Use physics engine to generate waypoints
            waypoints = physics_engine.step(start, transmitted_target, steps)
            motion_waypoints.extend(waypoints)

            delay_sum_ms += cmd.simulated_delay_ms
            delay_samples += 1
            wireless_transmissions += 1
            ber_sum += ber
            last_ber = ber
            total_wireless_delay_ms += wireless_delay_ms
            last_wireless_delay_ms = wireless_delay_ms
            trajectory_error_sum += trajectory_error_mean
            last_trajectory_error_mean = trajectory_error_mean

            await websocket.send_json(
                {
                    "type": "ack",
                    "cmd_seq": cmd.cmd_seq,
                    "client_timestamp": cmd.client_timestamp,
                    "server_recv_ts": cmd.apply_ts - cmd.simulated_delay_ms / 1000.0,
                    "server_apply_ts": time.time(),
                    "simulated_delay_ms": round(cmd.simulated_delay_ms, 2),
                    "ber": round(ber, 6),
                    "wireless_delay_ms": round(wireless_delay_ms, 2),
                    "trajectory_error_mean": round(trajectory_error_mean, 5),
                    "wireless_mode": wireless.mode,
                    "ebno_db": round(wireless.ebno_db, 2),
                    "wireless_engine": wireless_engine.get_name(),
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
            average_ber = (ber_sum / wireless_transmissions) if wireless_transmissions > 0 else 0.0
            trajectory_error_mean = (trajectory_error_sum / wireless_transmissions) if wireless_transmissions > 0 else 0.0
            total_run_time_s = time.time() - run_start_ts

            await websocket.send_json(
                {
                    "type": "telemetry",
                    "seq": telemetry_seq,
                    "server_ts": time.time(),
                    "wireless_stats": {
                        "average_ber": round(average_ber, 6),
                        "last_ber": round(last_ber, 6),
                        "wireless_delay_ms": round(last_wireless_delay_ms, 2),
                        "total_wireless_delay_ms": round(total_wireless_delay_ms, 2),
                        "trajectory_error_mean": round(trajectory_error_mean, 5),
                        "last_trajectory_error_mean": round(last_trajectory_error_mean, 5),
                        "transmission_count": wireless_transmissions,
                    },
                    "experiment_config": {
                        "wireless_mode": wireless.mode,
                        "ebno_db": round(wireless.ebno_db, 2),
                        "wireless_engine": wireless_engine.get_name(),
                        "physics_mode": physics_engine.get_name(),
                        "force_sensor_enabled": wireless.force_sensor_enabled,
                    },
                    "wireless_engine": {
                        "requested": wireless.engine_requested,
                        **wireless_engine.runtime_status(),
                    },
                    "runtime_stats": {
                        "total_run_time_s": round(total_run_time_s, 2),
                        "queue_pending": len(queue),
                    },
                    "legacy_network_stats": {
                        "avg_total_delay_ms": round(avg_delay, 2),
                        "observed_loss_rate": round(observed_loss, 4),
                    },
                    "queue": {
                        "pending": len(queue),
                        "waypoint_pending": len(motion_waypoints),
                    },
                    "simulation_status": {
                        "joint_positions": joints,
                    },
                    "physics": {
                        "requested": physics_requested,
                        **physics_engine.runtime_status(),
                        **physics_engine.metrics(latest_target_positions),
                    },
                }
            )

            active_joints = joints[:4] + [0.0] * max(0, 4 - len(joints))
            EXPERIMENT_HISTORY.append(
                {
                    "sample_ts": round(time.time(), 6),
                    "seq": telemetry_seq,
                    "average_ber": round(average_ber, 6),
                    "last_ber": round(last_ber, 6),
                    "wireless_delay_ms": round(last_wireless_delay_ms, 2),
                    "total_wireless_delay_ms": round(total_wireless_delay_ms, 2),
                    "trajectory_error_mean": round(trajectory_error_mean, 6),
                    "transmission_count": wireless_transmissions,
                    "total_run_time_s": round(total_run_time_s, 2),
                    "queue_pending": len(queue),
                    "wireless_mode": wireless.mode,
                    "ebno_db": round(wireless.ebno_db, 2),
                    "physics_mode": physics_engine.get_name(),
                    "force_sensor_enabled": wireless.force_sensor_enabled,
                    "active_joint_1": round(float(active_joints[0]), 6),
                    "active_joint_2": round(float(active_joints[1]), 6),
                    "active_joint_3": round(float(active_joints[2]), 6),
                    "active_joint_4": round(float(active_joints[3]), 6),
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
        physics_engine.cleanup()

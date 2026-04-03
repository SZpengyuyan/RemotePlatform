import { Component, ErrorInfo, ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Grid, Slider } from "@mui/material";
import { Canvas, useLoader } from "@react-three/fiber";
import { ContactShadows, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { Box3, Group, Mesh, MeshStandardMaterial, Vector3 } from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

type Telemetry = {
  seq: number;
  averageBer: number;
  lastBer: number;
  wirelessDelayMs: number;
  totalWirelessDelayMs: number;
  trajectoryErrorMean: number;
  transmissionCount: number;
  totalRunTimeS: number;
  wirelessMode: string;
  ebnoDb: number;
  physicsMode: string;
  queuePending: number;
};

type WirelessProfile = {
  key: string;
  label: string;
  mode: "basic_awgn" | "advanced_cdl_ofdm";
  ebnoDb: number;
};

type ModelErrorBoundaryProps = {
  fallback: ReactNode;
  onError?: () => void;
  children: ReactNode;
};

type ModelErrorBoundaryState = {
  hasError: boolean;
};

class ModelErrorBoundary extends Component<ModelErrorBoundaryProps, ModelErrorBoundaryState> {
  state: ModelErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ModelErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    this.props.onError?.();
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

const WIRELESS_PROFILES: WirelessProfile[] = [
  { key: "good", label: "低噪声-Basic", mode: "basic_awgn", ebnoDb: 12 },
  { key: "mid", label: "中噪声-Basic", mode: "basic_awgn", ebnoDb: 7 },
  { key: "bad", label: "高噪声-Advanced", mode: "advanced_cdl_ofdm", ebnoDb: 3 },
];

const DEFAULT_JOINTS = [0.3, -0.5, 0.7, 0.2];
const JOINT_PRESETS = [
  { key: "home", label: "回到初始位姿", joints: [0.3, -0.5, 0.7, 0.2] },
  { key: "left", label: "向左摆", joints: [1.0, -0.3, 0.5, 0.0] },
  { key: "right", label: "向右摆", joints: [-1.0, -0.3, 0.5, 0.0] },
  { key: "lift", label: "抬起手臂", joints: [0.2, 0.15, -0.2, -0.25] },
  { key: "reach", label: "向前伸展", joints: [0.0, -0.9, 1.1, 0.15] },
] as Array<{ key: string; label: string; joints: number[] }>;
const UR5E_OBJ_BASE = "/assets/robot/ur5e_obj";
const UR5E_OBJ_FILES = [
  "base_0.obj",
  "base_1.obj",
  "shoulder_0.obj",
  "shoulder_1.obj",
  "shoulder_2.obj",
  "upperarm_0.obj",
  "upperarm_1.obj",
  "upperarm_2.obj",
  "upperarm_3.obj",
  "forearm_0.obj",
  "forearm_1.obj",
  "forearm_2.obj",
  "forearm_3.obj",
  "wrist1_0.obj",
  "wrist1_1.obj",
  "wrist1_2.obj",
  "wrist2_0.obj",
  "wrist2_1.obj",
  "wrist2_2.obj",
  "wrist3.obj",
];

function isLikelyObj(content: string): boolean {
  // Basic OBJ signal: vertices + faces appear in plaintext.
  return /(^|\n)v\s+[-\d.eE]+\s+[-\d.eE]+\s+[-\d.eE]+/.test(content) && /(^|\n)f\s+/.test(content);
}

function wsUrl(): string {
  const explicitWs = import.meta.env.VITE_BACKEND_WS_URL as string | undefined;
  if (explicitWs && explicitWs.trim()) {
    return explicitWs.trim();
  }

  const backendHttp = import.meta.env.VITE_BACKEND_HTTP_URL as string | undefined;
  if (backendHttp && backendHttp.trim()) {
    const url = new URL(backendHttp.trim());
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  const host = window.location.hostname || "localhost";
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${host}:8000/ws`;
}

function metricColor(value: number, warn: number, danger: number, inverse = false): string {
  if (inverse) {
    if (value <= warn) return "#166534";
    if (value <= danger) return "#b45309";
    return "#b91c1c";
  }
  if (value >= danger) return "#b91c1c";
  if (value >= warn) return "#b45309";
  return "#166534";
}

function Arm3D({ joints, grip }: { joints: number[]; grip: number }) {
  const fingerOffset = 0.1 + grip * 0.12;
  return (
    <group>
      <mesh castShadow receiveShadow position={[0, 0.2, 0]}>
        <cylinderGeometry args={[0.7, 0.85, 0.4, 36]} />
        <meshStandardMaterial color="#3a4758" metalness={0.85} roughness={0.2} envMapIntensity={1.25} />
      </mesh>

      <group rotation={[0, joints[0] ?? 0, 0]} position={[0, 0.4, 0]}>
        <mesh castShadow receiveShadow position={[0, 0.2, 0]}>
          <cylinderGeometry args={[0.24, 0.24, 0.4, 24]} />
          <meshStandardMaterial color="#0f766e" metalness={0.72} roughness={0.2} envMapIntensity={1.15} />
        </mesh>

        <group position={[0, 0.4, 0]} rotation={[0, 0, joints[1] ?? 0]}>
          <mesh castShadow receiveShadow position={[0, 0.7, 0]}>
            <boxGeometry args={[0.35, 1.4, 0.35]} />
            <meshStandardMaterial color="#0ea5e9" metalness={0.55} roughness={0.22} envMapIntensity={1.1} />
          </mesh>

          <group position={[0, 1.4, 0]} rotation={[0, 0, joints[2] ?? 0]}>
            <mesh castShadow receiveShadow position={[0, 0.6, 0]}>
              <boxGeometry args={[0.28, 1.2, 0.28]} />
              <meshStandardMaterial color="#38bdf8" metalness={0.58} roughness={0.24} envMapIntensity={1.12} />
            </mesh>

            <group position={[0, 1.2, 0]} rotation={[0, 0, joints[3] ?? 0]}>
              <mesh castShadow receiveShadow position={[0, 0.24, 0]}>
                <boxGeometry args={[0.22, 0.48, 0.22]} />
                <meshStandardMaterial color="#0284c7" metalness={0.62} roughness={0.25} envMapIntensity={1.15} />
              </mesh>

              <group position={[0, 0.56, 0]}>
                <mesh castShadow receiveShadow position={[fingerOffset, 0.15, 0]}>
                  <boxGeometry args={[0.08, 0.3, 0.12]} />
                  <meshStandardMaterial
                    color="#f59e0b"
                    metalness={0.12}
                    roughness={0.42}
                    emissive="#7c2d12"
                    emissiveIntensity={0.08}
                  />
                </mesh>
                <mesh castShadow receiveShadow position={[-fingerOffset, 0.15, 0]}>
                  <boxGeometry args={[0.08, 0.3, 0.12]} />
                  <meshStandardMaterial
                    color="#f59e0b"
                    metalness={0.12}
                    roughness={0.42}
                    emissive="#7c2d12"
                    emissiveIntensity={0.08}
                  />
                </mesh>
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}

function RobotModelAsset({ joints, onReady }: { joints: number[]; onReady?: () => void }) {
  const loadedObjects = useLoader(
    OBJLoader,
    UR5E_OBJ_FILES.map((file) => `${UR5E_OBJ_BASE}/${file}`)
  );

  const materialPalette = useMemo(
    () => ({
      black: new MeshStandardMaterial({ color: "#111111", metalness: 0.65, roughness: 0.3 }),
      jointgray: new MeshStandardMaterial({ color: "#474747", metalness: 0.55, roughness: 0.35 }),
      linkgray: new MeshStandardMaterial({ color: "#d1d5db", metalness: 0.45, roughness: 0.4 }),
      urblue: new MeshStandardMaterial({ color: "#3ea9cc", metalness: 0.5, roughness: 0.35 }),
    }),
    []
  );

  const partMaterialKey: Record<string, keyof typeof materialPalette> = {
    "base_0.obj": "black",
    "base_1.obj": "jointgray",
    "shoulder_0.obj": "urblue",
    "shoulder_1.obj": "black",
    "shoulder_2.obj": "jointgray",
    "upperarm_0.obj": "linkgray",
    "upperarm_1.obj": "black",
    "upperarm_2.obj": "jointgray",
    "upperarm_3.obj": "urblue",
    "forearm_0.obj": "urblue",
    "forearm_1.obj": "linkgray",
    "forearm_2.obj": "black",
    "forearm_3.obj": "jointgray",
    "wrist1_0.obj": "black",
    "wrist1_1.obj": "urblue",
    "wrist1_2.obj": "jointgray",
    "wrist2_0.obj": "black",
    "wrist2_1.obj": "urblue",
    "wrist2_2.obj": "jointgray",
    "wrist3.obj": "linkgray",
  };

  const preparedParts = useMemo(() => {
    const map = new Map<string, ReturnType<typeof loadedObjects[number]["clone"]>>();

    UR5E_OBJ_FILES.forEach((file, idx) => {
      const src = loadedObjects[idx];
      const clone = src.clone(true);
      const key = partMaterialKey[file];
      const mat = materialPalette[key];
      clone.traverse((node) => {
        const mesh = node as Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.material = mat;
      });
      map.set(file, clone);
    });

    return map;
  }, [loadedObjects, materialPalette]);

  useEffect(() => {
    onReady?.();
  }, [onReady, preparedParts]);

  const modelRootRef = useRef<Group | null>(null);
  const [offset, setOffset] = useState<[number, number, number]>([0, 0, 0]);

  useEffect(() => {
    if (!modelRootRef.current) return;
    const box = new Box3().setFromObject(modelRootRef.current);
    const center = box.getCenter(new Vector3());
    setOffset([-center.x, -box.min.y, -center.z]);
  }, [preparedParts]);

  const y45Quat: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

  const part = (file: string) => {
    const obj = preparedParts.get(file);
    if (!obj) return null;
    return <primitive key={file} object={obj} />;
  };

  return (
    <group ref={modelRootRef} position={[offset[0], offset[1], offset[2]]} rotation={[0, Math.PI, 0]} scale={1.25}>
      <group>
        {part("base_0.obj")}
        {part("base_1.obj")}

        <group position={[0, 0, 0.163]} rotation={[0, 0, joints[0] ?? 0]}>
          {part("shoulder_0.obj")}
          {part("shoulder_1.obj")}
          {part("shoulder_2.obj")}

          <group position={[0, 0.138, 0]} quaternion={y45Quat}>
            <group rotation={[0, joints[1] ?? 0, 0]}>
              {part("upperarm_0.obj")}
              {part("upperarm_1.obj")}
              {part("upperarm_2.obj")}
              {part("upperarm_3.obj")}

              <group position={[0, -0.131, 0.425]} rotation={[0, joints[2] ?? 0, 0]}>
                {part("forearm_0.obj")}
                {part("forearm_1.obj")}
                {part("forearm_2.obj")}
                {part("forearm_3.obj")}

                <group position={[0, 0, 0.392]} quaternion={y45Quat}>
                  <group rotation={[0, joints[3] ?? 0, 0]}>
                    {part("wrist1_0.obj")}
                    {part("wrist1_1.obj")}
                    {part("wrist1_2.obj")}

                    <group position={[0, 0.127, 0]}>
                      {part("wrist2_0.obj")}
                      {part("wrist2_1.obj")}
                      {part("wrist2_2.obj")}

                      <group position={[0, 0, 0.1]}>{part("wrist3.obj")}</group>
                    </group>
                  </group>
                </group>
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}

export default function App() {
  const wsRef = useRef<WebSocket | null>(null);
  const cmdSeqRef = useRef(1);
  const jointTargetRef = useRef<number[]>(DEFAULT_JOINTS);
  const lastSentJointTargetRef = useRef<number[] | null>(null);
  const lastSentEeTargetRef = useRef<{ x: number; y: number; z: number; wristPitchDeg: number } | null>(null);

  const [connected, setConnected] = useState("未连接");
  const [joints, setJoints] = useState<number[]>(DEFAULT_JOINTS);
  const [displayJoints, setDisplayJoints] = useState<number[]>(DEFAULT_JOINTS);
  const [jointDraft, setJointDraft] = useState<number[]>(DEFAULT_JOINTS);
  const [activeProfile, setActiveProfile] = useState<string>(WIRELESS_PROFILES[0].key);
  const [hasRobotModelAsset, setHasRobotModelAsset] = useState(false);
  const [modelLoadFailed, setModelLoadFailed] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [eeTarget, setEeTarget] = useState({ x: 0.0, y: 1.7, z: 1.6 });
  const [eeWristPitchDeg, setEeWristPitchDeg] = useState(-25);
  const [wirelessModeDraft, setWirelessModeDraft] = useState<"basic_awgn" | "advanced_cdl_ofdm">("basic_awgn");
  const [ebnoDraft, setEbnoDraft] = useState(10);
  const [forceSensorEnabled, setForceSensorEnabled] = useState(false);

  const [telemetry, setTelemetry] = useState<Telemetry>({
    seq: 0,
    averageBer: 0,
    lastBer: 0,
    wirelessDelayMs: 0,
    totalWirelessDelayMs: 0,
    trajectoryErrorMean: 0,
    transmissionCount: 0,
    totalRunTimeS: 0,
    wirelessMode: "basic_awgn",
    ebnoDb: 10,
    physicsMode: "lightweight",
    queuePending: 0,
  });

  const send = useCallback((payload: object) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }, []);

  const isSameJointTarget = (left: number[], right: number[]): boolean =>
    left.length === right.length && left.every((value, index) => Math.abs(value - right[index]) < 1e-6);

  const sendEeTarget = useCallback(
    (target: { x: number; y: number; z: number }, wristPitchDeg: number) => {
      const nextTarget = { x: target.x, y: target.y, z: target.z, wristPitchDeg };
      const lastTarget = lastSentEeTargetRef.current;
      if (
        lastTarget &&
        Math.abs(lastTarget.x - nextTarget.x) < 1e-6 &&
        Math.abs(lastTarget.y - nextTarget.y) < 1e-6 &&
        Math.abs(lastTarget.z - nextTarget.z) < 1e-6 &&
        Math.abs(lastTarget.wristPitchDeg - nextTarget.wristPitchDeg) < 1e-6
      ) {
        return;
      }

      const cmdSeq = cmdSeqRef.current++;
      lastSentEeTargetRef.current = nextTarget;

      send({
        type: "robot_ee_control",
        cmd_seq: cmdSeq,
        client_timestamp: Date.now(),
        payload: {
          target_ee: target,
          wrist_pitch_deg: wristPitchDeg,
          steps: 14,
        },
      });
    },
    [send]
  );

  const sendJointTarget = useCallback(
    (targetJoints: number[], steps = 10) => {
      const lastTarget = lastSentJointTargetRef.current;
      if (lastTarget && isSameJointTarget(lastTarget, targetJoints)) {
        return;
      }

      const cmdSeq = cmdSeqRef.current++;
      lastSentJointTargetRef.current = [...targetJoints];

      send({
        type: "robot_joint_control",
        cmd_seq: cmdSeq,
        client_timestamp: Date.now(),
        payload: {
          target_positions: targetJoints,
          steps,
        },
      });
    },
    [send]
  );

  const applyProfile = useCallback(
    (profile: WirelessProfile) => {
      setActiveProfile(profile.key);
      setWirelessModeDraft(profile.mode);
      setEbnoDraft(profile.ebnoDb);
      send({
        type: "wireless_config",
        payload: {
          mode: profile.mode,
          ebno_db: profile.ebnoDb,
          force_sensor_enabled: forceSensorEnabled,
        },
      });
    },
    [send, forceSensorEnabled]
  );

  const applyWirelessConfig = useCallback(() => {
    setActiveProfile("custom");
    send({
      type: "wireless_config",
      payload: {
        mode: wirelessModeDraft,
        ebno_db: ebnoDraft,
        force_sensor_enabled: forceSensorEnabled,
      },
    });
  }, [send, wirelessModeDraft, ebnoDraft, forceSensorEnabled]);

  const applyEeControl = useCallback(() => {
    sendEeTarget(eeTarget, eeWristPitchDeg);
  }, [eeTarget, eeWristPitchDeg, sendEeTarget]);

  const applyJointControl = useCallback(() => {
    sendJointTarget(jointDraft, 12);
  }, [jointDraft, sendJointTarget]);

  const applyJointPreset = useCallback(
    (presetJoints: ReadonlyArray<number>) => {
      setJointDraft([...presetJoints]);
      setJoints([...presetJoints]);
      sendJointTarget([...presetJoints], 12);
    },
    [sendJointTarget]
  );

  const reset = useCallback(() => {
    setJoints(DEFAULT_JOINTS);
    jointTargetRef.current = [...DEFAULT_JOINTS];
    lastSentJointTargetRef.current = null;
    lastSentEeTargetRef.current = null;
    setDisplayJoints([...DEFAULT_JOINTS]);
    setJointDraft([...DEFAULT_JOINTS]);
    setEeTarget({ x: 0.0, y: 1.7, z: 1.6 });
    setEeWristPitchDeg(-25);
    send({ type: "robot_reset", payload: { initial_positions: [0, 0, 0, 0, 0, 0, 0] } });
  }, [send]);

  useEffect(() => {
    let disposed = false;

    const checkModelAsset = async () => {
      try {
        // Validate all required OBJ files before enabling real-model path.
        const checks = await Promise.all(
          UR5E_OBJ_FILES.map((file) => fetch(`${UR5E_OBJ_BASE}/${file}`, { cache: "no-store" }))
        );
        const response = checks[0];
        const text = await response.text();
        if (!disposed) {
          setHasRobotModelAsset(checks.every((item) => item.ok) && isLikelyObj(text));
          setModelLoadFailed(false);
        }
      } catch {
        if (!disposed) {
          setHasRobotModelAsset(false);
          setModelLoadFailed(false);
        }
      }
    };

    void checkModelAsset();

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!hasRobotModelAsset || modelReady || modelLoadFailed) return;
  }, [hasRobotModelAsset, modelReady, modelLoadFailed]);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;

      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      setConnected("连接中");

      ws.onopen = () => {
        setConnected("已连接");
        applyProfile(WIRELESS_PROFILES[0]);
      };
      ws.onerror = () => setConnected("连接错误");
      ws.onclose = () => {
        setConnected("已断开，重连中");
        if (!disposed) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data) as {
          type?: string;
          seq?: number;
          wireless_stats?: {
            average_ber?: number;
            last_ber?: number;
            wireless_delay_ms?: number;
            total_wireless_delay_ms?: number;
            trajectory_error_mean?: number;
            transmission_count?: number;
          };
          experiment_config?: { wireless_mode?: string; ebno_db?: number; physics_mode?: string; force_sensor_enabled?: boolean };
          runtime_stats?: { total_run_time_s?: number; queue_pending?: number };
          queue?: { pending?: number };
          simulation_status?: { joint_positions?: number[] };
        };

        if (data.type === "ack") {
          return;
        }

        if (data.type !== "telemetry") return;

        setTelemetry({
          seq: data.seq ?? 0,
          averageBer: data.wireless_stats?.average_ber ?? 0,
          lastBer: data.wireless_stats?.last_ber ?? 0,
          wirelessDelayMs: data.wireless_stats?.wireless_delay_ms ?? 0,
          totalWirelessDelayMs: data.wireless_stats?.total_wireless_delay_ms ?? 0,
          trajectoryErrorMean: data.wireless_stats?.trajectory_error_mean ?? 0,
          transmissionCount: data.wireless_stats?.transmission_count ?? 0,
          totalRunTimeS: data.runtime_stats?.total_run_time_s ?? 0,
          wirelessMode: data.experiment_config?.wireless_mode ?? "basic_awgn",
          ebnoDb: data.experiment_config?.ebno_db ?? 10,
          physicsMode: data.experiment_config?.physics_mode ?? "lightweight",
          queuePending: data.runtime_stats?.queue_pending ?? data.queue?.pending ?? 0,
        });

        const next = data.simulation_status?.joint_positions ?? [];
        if (next.length >= 4) {
          const synced = [next[0], next[1], next[2], next[3]];
          setJoints(synced);
          jointTargetRef.current = synced;
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    jointTargetRef.current = joints;
  }, [joints]);

  useEffect(() => {
    let frameId = 0;

    const tick = () => {
      setDisplayJoints((previous) => {
        const target = jointTargetRef.current;
        const next = previous.map((value, index) => {
          const delta = (target[index] ?? value) - value;
          return Math.abs(delta) < 0.0008 ? target[index] ?? value : value + delta * 0.16;
        });
        return next;
      });
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  const berColor = useMemo(() => metricColor(telemetry.averageBer * 100, 1.5, 4.0), [telemetry.averageBer]);
  const wirelessDelayColor = useMemo(() => metricColor(telemetry.wirelessDelayMs, 10, 20), [telemetry.wirelessDelayMs]);
  const trajectoryErrorColor = useMemo(
    () => metricColor(telemetry.trajectoryErrorMean * 1000, 8, 20),
    [telemetry.trajectoryErrorMean]
  );

  return (
    <div style={{ minHeight: "100vh", padding: 16, background: "linear-gradient(145deg, #f8fafc 0%, #eaf0ff 100%)" }}>
      <div style={{ margin: "0 auto", maxWidth: 1500 }}>
        <Card style={{ padding: 14, marginBottom: 14, borderRadius: 14 }}>
          <h2 style={{ margin: 0 }}>机器人远程操控仿真与可视化平台</h2>
          <p style={{ marginTop: 8, marginBottom: 0, color: "#334155" }}>
            WebSocket状态：{connected} | 序号：#{telemetry.seq}
          </p>
        </Card>

        <Grid container spacing={2}>
          <Grid item xs={12} md={4} lg={4}>
            <Card style={{ padding: 14, borderRadius: 14, position: "sticky", top: 12, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
              <h3 style={{ marginTop: 0 }}>机械臂控制</h3>
              <p style={{ marginTop: -6, marginBottom: 10, color: "#64748b", fontSize: 12 }}>
                提示：详细说明已移到页面最下方，方便你调参数时同时观察模型。
              </p>
              <div style={{ display: "grid", gap: 10 }}>
                <Card variant="outlined" style={{ padding: 10 }}>
                  <p style={{ margin: "0 0 6px", color: "#334155", fontWeight: 700 }}>关节直接控制</p>
                  <p style={{ margin: "0 0 8px", color: "#64748b", fontSize: 12 }}>
                    不需要理解 IK，直接拖动关节角就能移动机械臂。
                  </p>
                  {jointDraft.map((value, index) => (
                    <div key={`joint-${index}`} style={{ marginBottom: 8 }}>
                      <p style={{ margin: "0 0 2px", color: "#475569", fontSize: 12 }}>
                        关节 {index + 1}: {value.toFixed(2)} rad
                      </p>
                      <Slider
                        min={-2.6}
                        max={2.6}
                        step={0.01}
                        value={value}
                        onChange={(_, v) => {
                          const next = [...jointDraft];
                          next[index] = v as number;
                          setJointDraft(next);
                        }}
                      />
                    </div>
                  ))}
                  <Button variant="contained" onClick={applyJointControl} fullWidth>
                    发送关节目标
                  </Button>
                </Card>

                <Card variant="outlined" style={{ padding: 10 }}>
                  <p style={{ margin: "0 0 6px", color: "#334155", fontWeight: 700 }}>末端目标控制（IK）</p>
                  <p style={{ margin: "0 0 2px", color: "#475569", fontSize: 12 }}>X: {eeTarget.x.toFixed(2)} m</p>
                  <Slider
                    min={-1.2}
                    max={1.2}
                    step={0.02}
                    value={eeTarget.x}
                    onChange={(_, v) => setEeTarget((prev) => ({ ...prev, x: v as number }))}
                  />
                  <p style={{ margin: "0 0 2px", color: "#475569", fontSize: 12 }}>Y: {eeTarget.y.toFixed(2)} m</p>
                  <Slider
                    min={0.6}
                    max={2.4}
                    step={0.02}
                    value={eeTarget.y}
                    onChange={(_, v) => setEeTarget((prev) => ({ ...prev, y: v as number }))}
                  />
                  <p style={{ margin: "0 0 2px", color: "#475569", fontSize: 12 }}>Z: {eeTarget.z.toFixed(2)} m</p>
                  <Slider
                    min={0.2}
                    max={2.8}
                    step={0.02}
                    value={eeTarget.z}
                    onChange={(_, v) => setEeTarget((prev) => ({ ...prev, z: v as number }))}
                  />
                  <p style={{ margin: "0 0 2px", color: "#475569", fontSize: 12 }}>腕部俯仰: {eeWristPitchDeg}°</p>
                  <Slider
                    min={-120}
                    max={80}
                    step={1}
                    value={eeWristPitchDeg}
                    onChange={(_, v) => setEeWristPitchDeg(v as number)}
                  />
                  <Button variant="contained" color="secondary" onClick={applyEeControl} fullWidth>
                    发送末端目标
                  </Button>
                </Card>

                <Card variant="outlined" style={{ padding: 10 }}>
                  <p style={{ margin: "0 0 6px", color: "#334155", fontWeight: 700 }}>一键姿态预设</p>
                  <p style={{ margin: "0 0 8px", color: "#64748b", fontSize: 12 }}>
                    适合演示：点击即走一个常见姿态，不需要先理解关节或末端坐标。
                  </p>
                  <div style={{ display: "grid", gap: 8 }}>
                    {JOINT_PRESETS.map((preset) => (
                      <Button key={preset.key} variant="outlined" onClick={() => applyJointPreset(preset.joints)} fullWidth>
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                </Card>

                <Card variant="outlined" style={{ padding: 10 }}>
                  <p style={{ margin: "0 0 6px", color: "#334155", fontWeight: 700 }}>无线实验参数</p>
                  <p style={{ margin: "0 0 6px", color: "#64748b", fontSize: 12 }}>
                    后端已应用：{telemetry.wirelessMode} | Eb/No {telemetry.ebnoDb.toFixed(1)} dB
                  </p>
                  <Card variant="outlined" style={{ padding: 8, marginBottom: 8, background: "#f8fafc", borderStyle: "dashed" }}>
                    <p style={{ margin: 0, color: "#334155", fontSize: 12, lineHeight: 1.55 }}>
                      参数解释：<br />
                      1) `advanced_cdl_ofdm` 更接近真实无线环境，通常更稳但处理更慢。<br />
                      2) `Eb/No` 越高，信号相对噪声越强，BER 往往更低。<br />
                      3) 噪声越大，误码和轨迹偏差越明显。
                    </p>
                  </Card>
                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <Button
                        variant={wirelessModeDraft === "basic_awgn" ? "contained" : "outlined"}
                        onClick={() => setWirelessModeDraft("basic_awgn")}
                      >
                        Basic AWGN
                      </Button>
                      <Button
                        variant={wirelessModeDraft === "advanced_cdl_ofdm" ? "contained" : "outlined"}
                        onClick={() => setWirelessModeDraft("advanced_cdl_ofdm")}
                      >
                        Advanced CDL+OFDM
                      </Button>
                    </div>
                    <p style={{ margin: "0 0 2px", color: "#475569", fontSize: 12 }}>Eb/No: {ebnoDraft.toFixed(1)} dB</p>
                    <Slider min={-2} max={30} step={0.5} value={ebnoDraft} onChange={(_, v) => setEbnoDraft(v as number)} />
                    <Button
                      variant={forceSensorEnabled ? "contained" : "outlined"}
                      color={forceSensorEnabled ? "secondary" : "primary"}
                      onClick={() => setForceSensorEnabled((prev) => !prev)}
                    >
                      力传感标志：{forceSensorEnabled ? "开启" : "关闭"}
                    </Button>
                    <Button variant="contained" onClick={applyWirelessConfig} fullWidth>
                      应用无线参数
                    </Button>
                  </div>
                </Card>

                <Button variant="text" color="error" onClick={reset}>复位</Button>
                {WIRELESS_PROFILES.map((profile) => (
                  <Button
                    key={profile.key}
                    variant={activeProfile === profile.key ? "contained" : "outlined"}
                    onClick={() => applyProfile(profile)}
                  >
                    {profile.label}
                  </Button>
                ))}
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} md={5}>
            <Card style={{ padding: 14, borderRadius: 14, position: "sticky", top: 12 }}>
              <h3 style={{ marginTop: 0 }}>3D机械臂</h3>
              <p style={{ marginTop: -6, marginBottom: 10, color: "#475569", fontSize: 12 }}>
                {hasRobotModelAsset
                  ? modelLoadFailed
                    ? "真实模型加载失败，已回退内置几何机械臂"
                    : "已加载真实模型资产（ur5e OBJ）"
                  : "未检测到模型资产，使用内置几何机械臂"}
              </p>
              <div style={{ height: "calc(100vh - 210px)", minHeight: 420, borderRadius: 12, overflow: "hidden", background: "#dbeafe" }}>
                <Canvas
                  shadows
                  gl={{ antialias: true, powerPreference: "high-performance" }}
                  dpr={[1, 1.35]}
                >
                  <PerspectiveCamera makeDefault position={[3.8, 2.55, 4.4]} fov={48} />
                  <color attach="background" args={["#dbeafe"]} />
                  <fog attach="fog" args={["#dbeafe", 8, 18]} />

                  <ambientLight intensity={0.25} />
                  <hemisphereLight intensity={0.5} color="#f8fafc" groundColor="#94a3b8" />
                  <directionalLight
                    castShadow
                    intensity={1.5}
                    position={[5.5, 7.5, 4.5]}
                    shadow-mapSize-width={1024}
                    shadow-mapSize-height={1024}
                    shadow-bias={-0.00008}
                  />
                  <spotLight
                    castShadow
                    intensity={0.85}
                    angle={0.42}
                    penumbra={0.75}
                    position={[-3.6, 5.2, 2.5]}
                    color="#dbeafe"
                  />
                  <pointLight intensity={0.5} position={[2.2, 2.1, -2.8]} color="#bfdbfe" />
                  <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
                    <planeGeometry args={[12, 12]} />
                    <meshStandardMaterial color="#d6deea" roughness={0.78} metalness={0.08} />
                  </mesh>

                  {hasRobotModelAsset ? (
                    <ModelErrorBoundary fallback={<Arm3D joints={displayJoints} grip={0.7} />} onError={() => setModelLoadFailed(true)}>
                      <Suspense fallback={<Arm3D joints={displayJoints} grip={0.7} />}>
                        <RobotModelAsset joints={displayJoints} onReady={() => setModelReady(true)} />
                      </Suspense>
                    </ModelErrorBoundary>
                  ) : (
                    <Arm3D joints={displayJoints} grip={0.7} />
                  )}
                  <ContactShadows
                    position={[0, 0, 0]}
                    opacity={0.55}
                    scale={8.8}
                    blur={2.8}
                    far={3.8}
                    color="#1e293b"
                  />
                  <OrbitControls makeDefault enablePan={false} target={[0, 1.2, 0]} minDistance={2.8} maxDistance={11} />
                </Canvas>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} md={3}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={12}>
                <Card style={{ padding: 14, borderRadius: 14 }}>
                  <p style={{ margin: 0, color: "#475569" }}>平均误码率 BER</p>
                  <div style={{ fontSize: 38, fontWeight: 700, color: berColor }}>{(telemetry.averageBer * 100).toFixed(3)}%</div>
                  <p style={{ margin: "6px 0 0", color: "#64748b", fontSize: 12 }}>
                    最近一次 BER：{(telemetry.lastBer * 100).toFixed(3)}%
                  </p>
                </Card>
              </Grid>
              <Grid item xs={12} sm={6} md={12}>
                <Card style={{ padding: 14, borderRadius: 14 }}>
                  <p style={{ margin: 0, color: "#475569" }}>无线链路处理时延</p>
                  <div style={{ fontSize: 38, fontWeight: 700, color: wirelessDelayColor }}>
                    {telemetry.wirelessDelayMs.toFixed(1)} ms
                  </div>
                  <p style={{ margin: "6px 0 0", color: "#64748b", fontSize: 12 }}>
                    累计无线时延：{telemetry.totalWirelessDelayMs.toFixed(1)} ms
                  </p>
                </Card>
              </Grid>
              <Grid item xs={12} sm={6} md={12}>
                <Card style={{ padding: 14, borderRadius: 14 }}>
                  <p style={{ margin: 0, color: "#475569" }}>轨迹误差均值</p>
                  <div style={{ fontSize: 38, fontWeight: 700, color: trajectoryErrorColor }}>
                    {(telemetry.trajectoryErrorMean * 1000).toFixed(2)} mrad
                  </div>
                  <p style={{ margin: "6px 0 0", color: "#64748b", fontSize: 12 }}>
                    传输次数：{telemetry.transmissionCount}
                  </p>
                </Card>
              </Grid>
              <Grid item xs={12} sm={6} md={12}>
                <Card style={{ padding: 14, borderRadius: 14 }}>
                  <p style={{ margin: 0, color: "#475569" }}>实验运行状态</p>
                  <div style={{ fontSize: 34, fontWeight: 700, color: "#0f172a" }}>{telemetry.totalRunTimeS.toFixed(1)} s</div>
                  <p style={{ margin: "6px 0 0", color: "#64748b", fontSize: 12 }}>
                    模式：{telemetry.wirelessMode} | Eb/No：{telemetry.ebnoDb.toFixed(1)} dB | 物理引擎：{telemetry.physicsMode}
                  </p>
                  <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 12 }}>
                    队列积压：{telemetry.queuePending}
                  </p>
                </Card>
              </Grid>
            </Grid>
          </Grid>
        </Grid>

        <Card style={{ marginTop: 12, padding: 14, borderRadius: 14 }}>
          <h3 style={{ marginTop: 0, marginBottom: 10 }}>快速说明</h3>
          <Grid container spacing={1.5}>
            <Grid item xs={12} md={4}>
              <Card variant="outlined" style={{ padding: 10, background: "#f8fafc" }}>
                <p style={{ margin: 0, color: "#334155", fontWeight: 700 }}>三种控制方式</p>
                <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 12, lineHeight: 1.5 }}>
                  关节直接控制最直观；一键姿态预设适合演示；末端目标控制适合指定空间位置。
                </p>
              </Card>
            </Grid>
            <Grid item xs={12} md={4}>
              <Card variant="outlined" style={{ padding: 10, background: "#f8fafc" }}>
                <p style={{ margin: 0, color: "#334155", fontWeight: 700 }}>怎么看指标</p>
                <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 12, lineHeight: 1.5 }}>
                  BER 越低越好；无线时延越低越快；轨迹误差越低越准。
                </p>
              </Card>
            </Grid>
            <Grid item xs={12} md={4}>
              <Card variant="outlined" style={{ padding: 10, background: "#f8fafc" }}>
                <p style={{ margin: 0, color: "#334155", fontWeight: 700 }}>怎么做实验</p>
                <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 12, lineHeight: 1.5 }}>
                  切换无线模式与 Eb/No 后重复同一动作，对比 BER、时延和误差变化即可。
                </p>
              </Card>
            </Grid>
          </Grid>
        </Card>
      </div>
    </div>
  );
}

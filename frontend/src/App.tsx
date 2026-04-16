import { Component, ErrorInfo, ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Slider, Tab, Tabs } from "@mui/material";
import useMediaQuery from "@mui/material/useMediaQuery";
import { Canvas, useLoader } from "@react-three/fiber";
import { ContactShadows, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { Box3, Group, Mesh, MeshStandardMaterial, Vector3 } from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import NetworkTopologyMap, { TopologyLink, TopologyNode } from "./NetworkTopologyMap";

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
  wirelessEngineRequested: string;
  wirelessEngineActive: string;
  wirelessEngineFallback: boolean;
  wirelessEngineFallbackReason: string;
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

const BASE_TOPOLOGY_NODES: TopologyNode[] = [
  { id: "sender", name: "发送端 / 人", role: "sender", lat: 31.2304, lng: 121.4737 },
  { id: "receiver", name: "接收端 / 机械臂", role: "receiver", lat: 22.5431, lng: 114.0579 },
];

function clampRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildTopologyLinks(telemetry: Telemetry): TopologyLink[] {
  const modeFactor = telemetry.wirelessMode === "advanced_cdl_ofdm" ? 1.2 : 1.0;
  const qualityFactor = clampRange((telemetry.ebnoDb + 2) / 32, 0.1, 1.1);
  const baseDelay = Math.max(18, telemetry.wirelessDelayMs || 42);
  const berFactor = clampRange(1 + telemetry.averageBer * 32, 0.8, 2.5);

  const endToEndLatency = baseDelay * modeFactor * berFactor * (1.18 - qualityFactor * 0.36);
  const lossBase = clampRange(telemetry.averageBer * 0.72 + (1 - qualityFactor) * 0.03, 0.002, 0.1);

  return [
    {
      id: "end-to-end",
      from: "sender",
      to: "receiver",
      latencyMs: clampRange(endToEndLatency, 12, 260),
      packetLoss: clampRange(lossBase, 0.001, 0.12),
      jitterMs: clampRange(endToEndLatency * 0.17, 1.4, 38),
    },
  ];
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
  const [activeTab, setActiveTab] = useState<"control" | "network">("control");

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
    wirelessEngineRequested: "external",
    wirelessEngineActive: "unknown",
    wirelessEngineFallback: false,
    wirelessEngineFallbackReason: "",
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
          wireless_engine?: {
            requested?: string;
            active?: string;
            using_internal_fallback?: boolean;
            fallback_reason?: string;
            external_module_available?: boolean;
          };
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
          wirelessEngineRequested: data.wireless_engine?.requested ?? "external",
          wirelessEngineActive: data.wireless_engine?.active ?? "unknown",
          wirelessEngineFallback: data.wireless_engine?.using_internal_fallback ?? false,
          wirelessEngineFallbackReason: data.wireless_engine?.fallback_reason ?? "",
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
  const topologyLinks = useMemo(() => buildTopologyLinks(telemetry), [telemetry]);
  const topologyNodes = BASE_TOPOLOGY_NODES;
  const totalTopologyLatency = useMemo(
    () => topologyLinks.reduce((sum, link) => sum + link.latencyMs, 0),
    [topologyLinks]
  );
  const averageTopologyLoss = useMemo(
    () => topologyLinks.reduce((sum, link) => sum + link.packetLoss, 0) / Math.max(1, topologyLinks.length),
    [topologyLinks]
  );
  const isCompactScreen = useMediaQuery("(max-width: 1100px)");
  const isNarrowScreen = useMediaQuery("(max-width: 780px)");
  const isVeryNarrowScreen = useMediaQuery("(max-width: 560px)");
  const pagePadding = isVeryNarrowScreen ? 6 : isNarrowScreen ? 8 : isCompactScreen ? 10 : 14;
  const cardPadding = isVeryNarrowScreen ? 8 : isNarrowScreen ? 10 : 12;
  const panelPadding = isVeryNarrowScreen ? 7 : 9;
  const sectionGap = isVeryNarrowScreen ? 6 : 8;
  const buttonSize = isNarrowScreen ? "small" : "medium";
  const headerColumns = isCompactScreen ? "1fr" : "minmax(0, 1.6fr) minmax(0, 1fr)";
  const mainColumns = isCompactScreen
    ? "1fr"
    : "minmax(0, 1.06fr) minmax(0, 1.58fr) minmax(0, 0.96fr)";
  const controlInnerColumns = isVeryNarrowScreen ? "1fr" : "repeat(auto-fit, minmax(180px, 1fr))";
  const metricsGridColumns = "repeat(auto-fit, minmax(150px, 1fr))";
  const networkColumns = isCompactScreen ? "1fr" : "minmax(0, 1.65fr) minmax(0, 0.95fr)";
  const actionGridColumns = "repeat(auto-fit, minmax(112px, 1fr))";
  const mapHeight = isVeryNarrowScreen
    ? "clamp(260px, 34vh, 360px)"
    : isNarrowScreen
      ? "clamp(300px, 38vh, 420px)"
      : "clamp(360px, 44vh, 540px)";

  return (
    <div style={{ minHeight: "100dvh", padding: pagePadding, overflowX: "hidden", overflowY: "auto", background: "linear-gradient(145deg, #f8fafc 0%, #eaf0ff 100%)" }}>
      <div style={{ margin: "0 auto", maxWidth: 1560, height: "100%", display: "grid", gridTemplateRows: "auto 1fr", gap: sectionGap, minHeight: 0 }}>
        <Card style={{ padding: cardPadding, borderRadius: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: headerColumns, gap: 12, alignItems: "center" }}>
            <div>
              <h2 style={{ margin: 0, fontSize: "clamp(18px, 1.9vw, 22px)", lineHeight: 1.15 }}>机器人远程操控仿真与可视化平台</h2>
              <p style={{ margin: "4px 0 0", color: "#334155", fontSize: 12, lineHeight: 1.45 }}>WebSocket 状态：{connected} | 序号：#{telemetry.seq}</p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: actionGridColumns, gap: sectionGap }}>
              <Card variant="outlined" style={{ padding: `${panelPadding}px ${panelPadding + 1}px`, background: "#f8fafc" }}>
                <p style={{ margin: 0, color: "#64748b", fontSize: 11 }}>无线模式</p>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>{telemetry.wirelessMode}</div>
              </Card>
              <Card variant="outlined" style={{ padding: `${panelPadding}px ${panelPadding + 1}px`, background: "#f8fafc" }}>
                <p style={{ margin: 0, color: "#64748b", fontSize: 11 }}>物理引擎</p>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>{telemetry.physicsMode}</div>
              </Card>
            </div>
          </div>
          <Tabs value={activeTab} onChange={(_, value) => setActiveTab(value)} style={{ marginTop: 6, minHeight: 34 }}>
            <Tab value="control" label="控制与仿真" style={{ minHeight: 34, padding: "4px 10px" }} />
            <Tab value="network" label="网络地图" style={{ minHeight: 34, padding: "4px 10px" }} />
          </Tabs>
        </Card>

        {activeTab === "control" ? (
          <div style={{ minHeight: 0, display: "grid", gridTemplateColumns: mainColumns, gap: sectionGap, alignItems: "stretch" }}>
            <Card style={{ padding: cardPadding, borderRadius: 14, minHeight: 0, display: "grid", gridTemplateRows: isCompactScreen ? "auto auto auto" : "repeat(2, minmax(0, 1fr))", gap: sectionGap }}>
              <Card variant="outlined" style={{ padding: panelPadding, background: "#ffffff", minHeight: 0 }}>
                <p style={{ margin: "0 0 4px", color: "#334155", fontWeight: 700 }}>关节直接控制</p>
                <p style={{ margin: "0 0 8px", color: "#64748b", fontSize: 12, lineHeight: 1.45 }}>拖动 4 个关节角，直接驱动机械臂。数值越大，某个关节转得越多。</p>
                <div style={{ display: "grid", gridTemplateColumns: controlInnerColumns, gap: 6 }}>
                  {jointDraft.map((value, index) => (
                    <div key={`joint-${index}`} style={{ minWidth: 0 }}>
                      <p style={{ margin: "0 0 2px", color: "#475569", fontSize: 12, lineHeight: 1.35 }}>J{index + 1}: {value.toFixed(2)} rad</p>
                      <Slider min={-2.6} max={2.6} step={0.01} value={value} onChange={(_, v) => {
                        const next = [...jointDraft];
                        next[index] = v as number;
                        setJointDraft(next);
                      }} />
                    </div>
                  ))}
                </div>
                <Button variant="contained" size={buttonSize} onClick={applyJointControl} fullWidth style={{ marginTop: 2 }}>发送关节目标</Button>
              </Card>

              <Card variant="outlined" style={{ padding: panelPadding, background: "#ffffff", minHeight: 0 }}>
                <p style={{ margin: "0 0 4px", color: "#334155", fontWeight: 700 }}>末端目标控制</p>
                <p style={{ margin: "0 0 6px", color: "#64748b", fontSize: 12, lineHeight: 1.45 }}>输入空间位置和腕部俯仰，让系统自动算出关节动作。更像“把手伸到哪里”，而不是手动调每个关节。</p>
                <div style={{ display: "grid", gridTemplateColumns: controlInnerColumns, gap: 6 }}>
                  <div>
                    <p style={{ margin: "0 0 2px", color: "#475569", fontSize: 12, lineHeight: 1.35 }}>X: {eeTarget.x.toFixed(2)} m</p>
                    <Slider min={-1.2} max={1.2} step={0.02} value={eeTarget.x} onChange={(_, v) => setEeTarget((prev) => ({ ...prev, x: v as number }))} />
                  </div>
                  <div>
                    <p style={{ margin: "0 0 2px", color: "#475569", fontSize: 12, lineHeight: 1.35 }}>Y: {eeTarget.y.toFixed(2)} m</p>
                    <Slider min={0.6} max={2.4} step={0.02} value={eeTarget.y} onChange={(_, v) => setEeTarget((prev) => ({ ...prev, y: v as number }))} />
                  </div>
                  <div>
                    <p style={{ margin: "0 0 2px", color: "#475569", fontSize: 12, lineHeight: 1.35 }}>Z: {eeTarget.z.toFixed(2)} m</p>
                    <Slider min={0.2} max={2.8} step={0.02} value={eeTarget.z} onChange={(_, v) => setEeTarget((prev) => ({ ...prev, z: v as number }))} />
                  </div>
                  <div>
                    <p style={{ margin: "0 0 2px", color: "#475569", fontSize: 12, lineHeight: 1.35 }}>腕部: {eeWristPitchDeg}°</p>
                    <Slider min={-120} max={80} step={1} value={eeWristPitchDeg} onChange={(_, v) => setEeWristPitchDeg(v as number)} />
                  </div>
                </div>
                <Button variant="contained" color="secondary" size={buttonSize} onClick={applyEeControl} fullWidth style={{ marginTop: 4 }}>发送末端目标</Button>
              </Card>

              <Card variant="outlined" style={{ padding: panelPadding, background: "#ffffff", minHeight: 0 }}>
                <p style={{ margin: "0 0 4px", color: "#334155", fontWeight: 700 }}>参数解释</p>
                <p style={{ margin: "4px 0", color: "#475569", fontSize: 12, lineHeight: 1.45 }}>
                  Basic AWGN 可以理解成“只有背景噪声的简单无线环境”，适合先看基础效果。Advanced CDL+OFDM 更像“真实场景里的复杂无线环境”，更接近现场，但计算也更重。
                </p>
                <p style={{ margin: "4px 0 0", color: "#475569", fontSize: 12, lineHeight: 1.45 }}>
                  Eb/No 可以简单理解成“信号比噪声强多少”，越高越清楚，BER 往往越低。如果噪声上升，误码率、无线时延和轨迹偏差通常都会更差。
                </p>
              </Card>
            </Card>

            <Card style={{ padding: cardPadding, borderRadius: 14, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <div>
                  <h3 style={{ margin: 0 }}>3D 机械臂</h3>
                  <p style={{ margin: "4px 0 0", color: "#475569", fontSize: 12 }}>
                    {hasRobotModelAsset ? (modelLoadFailed ? "真实模型加载失败，已回退内置几何机械臂" : "已加载真实模型资产（ur5e OBJ）") : "未检测到模型资产，使用内置几何机械臂"}
                  </p>
                </div>
                <div style={{ color: "#64748b", fontSize: 12, textAlign: "right" }}>运行 {telemetry.totalRunTimeS.toFixed(1)} s</div>
              </div>
              <div style={{ marginTop: sectionGap, flex: 1, borderRadius: 12, overflow: "hidden", background: "#dbeafe", aspectRatio: "16 / 10", minHeight: isVeryNarrowScreen ? 220 : isNarrowScreen ? 280 : 340 }}>
                <Canvas shadows gl={{ antialias: true, powerPreference: "high-performance" }} dpr={[1, 1.5]}>
                  <PerspectiveCamera makeDefault position={[3.8, 2.55, 4.4]} fov={48} />
                  <color attach="background" args={["#dbeafe"]} />
                  <fog attach="fog" args={["#dbeafe", 8, 18]} />
                  <ambientLight intensity={0.25} />
                  <hemisphereLight intensity={0.5} color="#f8fafc" groundColor="#94a3b8" />
                  <directionalLight castShadow intensity={1.5} position={[5.5, 7.5, 4.5]} shadow-mapSize-width={1024} shadow-mapSize-height={1024} shadow-bias={-0.00008} />
                  <spotLight castShadow intensity={0.85} angle={0.42} penumbra={0.75} position={[-3.6, 5.2, 2.5]} color="#dbeafe" />
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
                  <ContactShadows position={[0, 0, 0]} opacity={0.55} scale={8.8} blur={2.8} far={3.8} color="#1e293b" />
                  <OrbitControls makeDefault enablePan={false} target={[0, 1.2, 0]} minDistance={2.8} maxDistance={11} />
                </Canvas>
              </div>
            </Card>

            <Card style={{ padding: cardPadding, borderRadius: 14, minHeight: 0, display: "grid", gridTemplateRows: isCompactScreen ? "auto auto auto auto auto" : "minmax(0, 1fr) auto auto auto", gap: sectionGap }}>
              <div style={{ display: "grid", gridTemplateColumns: metricsGridColumns, gap: sectionGap, minHeight: 0 }}>
                <Card variant="outlined" style={{ padding: panelPadding, background: "#f8fafc" }}>
                  <p style={{ margin: 0, color: "#475569", fontSize: 12 }}>平均误码率 BER</p>
                  <div style={{ fontSize: "clamp(22px, 2.2vw, 30px)", fontWeight: 700, lineHeight: 1.1, color: berColor }}>{(telemetry.averageBer * 100).toFixed(3)}%</div>
                  <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 11 }}>最近一次：{(telemetry.lastBer * 100).toFixed(3)}%</p>
                </Card>
                <Card variant="outlined" style={{ padding: panelPadding, background: "#f8fafc" }}>
                  <p style={{ margin: 0, color: "#475569", fontSize: 12 }}>无线时延</p>
                  <div style={{ fontSize: "clamp(22px, 2.2vw, 30px)", fontWeight: 700, lineHeight: 1.1, color: wirelessDelayColor }}>{telemetry.wirelessDelayMs.toFixed(1)} ms</div>
                  <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 11 }}>累计：{telemetry.totalWirelessDelayMs.toFixed(1)} ms</p>
                </Card>
                <Card variant="outlined" style={{ padding: panelPadding, background: "#f8fafc" }}>
                  <p style={{ margin: 0, color: "#475569", fontSize: 12 }}>轨迹误差</p>
                  <div style={{ fontSize: "clamp(22px, 2.2vw, 30px)", fontWeight: 700, lineHeight: 1.1, color: trajectoryErrorColor }}>{(telemetry.trajectoryErrorMean * 1000).toFixed(2)} mrad</div>
                  <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 11 }}>传输次数：{telemetry.transmissionCount}</p>
                </Card>
                <Card variant="outlined" style={{ padding: panelPadding, background: "#f8fafc" }}>
                  <p style={{ margin: 0, color: "#475569", fontSize: 12 }}>运行状态</p>
                  <div style={{ fontSize: "clamp(22px, 2.2vw, 30px)", fontWeight: 700, lineHeight: 1.1, color: "#0f172a" }}>{telemetry.totalRunTimeS.toFixed(1)} s</div>
                  <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 11 }}>队列：{telemetry.queuePending}</p>
                </Card>
              </div>

              <Card variant="outlined" style={{ padding: panelPadding, background: "#ffffff" }}>
                <p style={{ margin: "0 0 4px", color: "#334155", fontWeight: 700 }}>无线参数</p>
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ display: "grid", gridTemplateColumns: actionGridColumns, gap: 6 }}>
                    <Button size={buttonSize} variant={wirelessModeDraft === "basic_awgn" ? "contained" : "outlined"} onClick={() => setWirelessModeDraft("basic_awgn")}>Basic AWGN</Button>
                    <Button size={buttonSize} variant={wirelessModeDraft === "advanced_cdl_ofdm" ? "contained" : "outlined"} onClick={() => setWirelessModeDraft("advanced_cdl_ofdm")}>Advanced CDL+OFDM</Button>
                  </div>
                  <div>
                    <p style={{ margin: "0 0 2px", color: "#475569", fontSize: 12, lineHeight: 1.35 }}>Eb/No: {ebnoDraft.toFixed(1)} dB</p>
                    <Slider min={-2} max={30} step={0.5} value={ebnoDraft} onChange={(_, v) => setEbnoDraft(v as number)} />
                  </div>
                  <Button size={buttonSize} variant={forceSensorEnabled ? "contained" : "outlined"} color={forceSensorEnabled ? "secondary" : "primary"} onClick={() => setForceSensorEnabled((prev) => !prev)}>力传感：{forceSensorEnabled ? "开启" : "关闭"}</Button>
                  <Button size={buttonSize} variant="contained" onClick={applyWirelessConfig} fullWidth>应用无线参数</Button>
                  <p style={{ margin: 0, color: "#64748b", fontSize: 11, lineHeight: 1.45 }}>{telemetry.wirelessMode} / {telemetry.ebnoDb.toFixed(1)} dB 已生效，切换后会立即下发到后端。</p>
                </div>
              </Card>

              <Card variant="outlined" style={{ padding: panelPadding, background: "#ffffff" }}>
                <p style={{ margin: "0 0 4px", color: "#334155", fontWeight: 700 }}>一键姿态预设</p>
                <div style={{ display: "grid", gridTemplateColumns: actionGridColumns, gap: 6 }}>
                  {JOINT_PRESETS.map((preset) => (
                    <Button key={preset.key} size={buttonSize} variant="outlined" onClick={() => applyJointPreset(preset.joints)} style={{ minWidth: 0 }}>
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </Card>

              <div style={{ display: "grid", gridTemplateColumns: actionGridColumns, gap: sectionGap }}>
                <Button size={buttonSize} variant="text" color="error" onClick={reset} style={{ justifyContent: "flex-start" }}>复位</Button>
                {WIRELESS_PROFILES.map((profile) => (
                  <Button size={buttonSize} key={profile.key} variant={activeProfile === profile.key ? "contained" : "outlined"} onClick={() => applyProfile(profile)} style={{ minWidth: 0 }}>{profile.label}</Button>
                ))}
              </div>
            </Card>
          </div>
        ) : (
          <div style={{ minHeight: 0, display: "grid", gridTemplateColumns: networkColumns, gap: sectionGap, alignItems: "stretch" }}>
            <NetworkTopologyMap title="发送端 -> 网络自动转发 -> 接收端" nodes={topologyNodes} links={topologyLinks} height={mapHeight} />
            <Card style={{ padding: cardPadding, borderRadius: 14, minHeight: 0, display: "grid", gridTemplateRows: isCompactScreen ? "auto auto auto" : "repeat(2, minmax(0, 1fr)) auto", gap: sectionGap }}>
              <div style={{ display: "grid", gridTemplateColumns: metricsGridColumns, gap: sectionGap }}>
                <Card variant="outlined" style={{ padding: panelPadding, background: "#f8fafc" }}>
                  <p style={{ margin: 0, color: "#64748b", fontSize: 12 }}>端到端总时延</p>
                  <div style={{ fontSize: "clamp(22px, 2.2vw, 30px)", fontWeight: 700, color: totalTopologyLatency >= 220 ? "#b91c1c" : totalTopologyLatency >= 140 ? "#b45309" : "#166534" }}>{totalTopologyLatency.toFixed(1)} ms</div>
                </Card>
                <Card variant="outlined" style={{ padding: panelPadding, background: "#f8fafc" }}>
                  <p style={{ margin: 0, color: "#64748b", fontSize: 12 }}>平均丢包率</p>
                  <div style={{ fontSize: "clamp(22px, 2.2vw, 30px)", fontWeight: 700, color: averageTopologyLoss >= 0.05 ? "#b91c1c" : averageTopologyLoss >= 0.02 ? "#b45309" : "#166534" }}>{(averageTopologyLoss * 100).toFixed(2)}%</div>
                </Card>
              </div>
              <Card variant="outlined" style={{ padding: panelPadding, background: "#ffffff" }}>
                <p style={{ margin: "0 0 4px", color: "#334155", fontWeight: 700 }}>链路明细</p>
                {topologyLinks.map((link) => (
                  <p key={link.id} style={{ margin: "4px 0", color: "#475569", fontSize: 12, lineHeight: 1.45 }}>{link.id}: {link.latencyMs.toFixed(1)} ms | {(link.packetLoss * 100).toFixed(2)}% loss | {link.jitterMs.toFixed(1)} ms jitter</p>
                ))}
              </Card>
              <Card variant="outlined" style={{ padding: panelPadding, background: "#f8fafc" }}>
                <p style={{ margin: "0 0 4px", color: "#334155", fontWeight: 700 }}>路由说明</p>
                <p style={{ margin: "4px 0", color: "#475569", fontSize: 12, lineHeight: 1.45 }}>这条路径代表命令在网络中的传递过程。总时延越低，控制越跟手；丢包越少，命令越完整；抖动越小，画面和动作越稳定。</p>
                <p style={{ margin: "4px 0 0", color: "#475569", fontSize: 12, lineHeight: 1.45 }}>路由器繁忙度可以简单理解成“当前有多堵”，数值越高，越容易排队和变慢。</p>
              </Card>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

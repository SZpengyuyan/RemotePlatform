import { Component, ErrorInfo, ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Grid, Slider } from "@mui/material";
import { Canvas, useLoader } from "@react-three/fiber";
import { ContactShadows, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { Box3, Group, Mesh, MeshStandardMaterial, Vector3 } from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

type Telemetry = {
  seq: number;
  latencyMs: number;
  jitterMs: number;
  lossRate: number;
  bandwidthKbps: number;
  backendLossRate: number;
  queuePending: number;
};

type NetworkProfile = {
  key: string;
  label: string;
  delayMs: number;
  jitterMs: number;
  lossRate: number;
  bandwidthKbps: number;
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

const NETWORK_PROFILES: NetworkProfile[] = [
  { key: "good", label: "良好网络", delayMs: 25, jitterMs: 3, lossRate: 0.001, bandwidthKbps: 12000 },
  { key: "mid", label: "中等拥塞", delayMs: 700, jitterMs: 220, lossRate: 0.12, bandwidthKbps: 320 },
  { key: "bad", label: "恶劣网络", delayMs: 2250, jitterMs: 750, lossRate: 0.45, bandwidthKbps: 64 },
];

const DEFAULT_JOINTS = [0.3, -0.5, 0.7, 0.2];
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
  const commandedJointsRef = useRef<number[]>(DEFAULT_JOINTS);
  const pendingRef = useRef<Map<number, number>>(new Map());
  const sentCountRef = useRef(0);
  const ackCountRef = useRef(0);
  const lastRttRef = useRef<number | null>(null);
  const jitterEwmaRef = useRef(0);

  const [connected, setConnected] = useState("未连接");
  const [joints, setJoints] = useState<number[]>(DEFAULT_JOINTS);
  const [activeProfile, setActiveProfile] = useState<string>(NETWORK_PROFILES[0].key);
  const [hasRobotModelAsset, setHasRobotModelAsset] = useState(false);
  const [modelLoadFailed, setModelLoadFailed] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [eeTarget, setEeTarget] = useState({ x: 0.0, y: 1.7, z: 1.6 });
  const [eeWristPitchDeg, setEeWristPitchDeg] = useState(-25);

  const [telemetry, setTelemetry] = useState<Telemetry>({
    seq: 0,
    latencyMs: 0,
    jitterMs: 0,
    lossRate: 0,
    bandwidthKbps: 0,
    backendLossRate: 0,
    queuePending: 0,
  });

  const send = useCallback((payload: object) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }, []);

  const sendEeTarget = useCallback(
    (target: { x: number; y: number; z: number }, wristPitchDeg: number) => {
      const cmdSeq = cmdSeqRef.current++;
      const ts = Date.now();
      pendingRef.current.set(cmdSeq, ts);
      sentCountRef.current += 1;

      send({
        type: "robot_ee_control",
        cmd_seq: cmdSeq,
        client_timestamp: ts,
        payload: {
          target_ee: target,
          wrist_pitch_deg: wristPitchDeg,
          steps: 14,
        },
      });
    },
    [send]
  );

  const applyProfile = useCallback(
    (profile: NetworkProfile) => {
      setActiveProfile(profile.key);
      send({
        type: "network_profile",
        payload: {
          delay_ms: profile.delayMs,
          jitter_ms: profile.jitterMs,
          loss_rate: profile.lossRate,
          bandwidth_kbps: profile.bandwidthKbps,
          queue_penalty_ms: profile.key === "bad" ? 300 : profile.key === "mid" ? 180 : 70,
        },
      });
    },
    [send]
  );

  const applyEeControl = useCallback(() => {
    sendEeTarget(eeTarget, eeWristPitchDeg);
  }, [eeTarget, eeWristPitchDeg, sendEeTarget]);

  const reset = useCallback(() => {
    setJoints(DEFAULT_JOINTS);
    commandedJointsRef.current = [...DEFAULT_JOINTS];
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

    // Prevent endless heavy loading from destabilizing the page on weaker GPUs.
    const timer = setTimeout(() => {
      setModelLoadFailed(true);
    }, 12000);

    return () => clearTimeout(timer);
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
        applyProfile(NETWORK_PROFILES[0]);
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
          cmd_seq?: number;
          client_timestamp?: number;
          seq?: number;
          network_stats?: { avg_total_delay_ms?: number; observed_loss_rate?: number };
          network_config?: { delay_ms?: number; jitter_ms?: number; loss_rate?: number; bandwidth_kbps?: number };
          queue?: { pending?: number };
          simulation_status?: { joint_positions?: number[] };
        };

        if (data.type === "ack") {
          const ackSeq = data.cmd_seq ?? -1;
          const sentTs = pendingRef.current.get(ackSeq);
          if (sentTs !== undefined) {
            pendingRef.current.delete(ackSeq);
            ackCountRef.current += 1;

            const rtt = Date.now() - sentTs;
            const last = lastRttRef.current;
            const j = last === null ? 0 : Math.abs(rtt - last);
            jitterEwmaRef.current = jitterEwmaRef.current * 0.8 + j * 0.2;
            lastRttRef.current = rtt;

            const sent = sentCountRef.current;
            const acked = ackCountRef.current;
            const calculatedLoss = sent > 0 ? (sent - acked) / sent : 0;

            setTelemetry((prev) => ({
              ...prev,
              latencyMs: rtt,
              jitterMs: jitterEwmaRef.current,
              lossRate: calculatedLoss,
            }));
          }
          return;
        }

        if (data.type !== "telemetry") return;

        const sent = sentCountRef.current;
        const acked = ackCountRef.current;
        const calculatedLoss = sent > 0 ? (sent - acked) / sent : 0;

        setTelemetry({
          seq: data.seq ?? 0,
          latencyMs: lastRttRef.current ?? data.network_stats?.avg_total_delay_ms ?? 0,
          jitterMs: jitterEwmaRef.current || data.network_config?.jitter_ms || 0,
          lossRate: calculatedLoss,
          bandwidthKbps: data.network_config?.bandwidth_kbps ?? 0,
          backendLossRate: data.network_stats?.observed_loss_rate ?? 0,
          queuePending: data.queue?.pending ?? 0,
        });

        const next = data.simulation_status?.joint_positions ?? [];
        if (next.length >= 4) {
          const synced = [next[0], next[1], next[2], next[3]];
          setJoints(synced);
          commandedJointsRef.current = synced;
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

  const latencyColor = useMemo(() => metricColor(telemetry.latencyMs, 80, 150), [telemetry.latencyMs]);
  const jitterColor = useMemo(() => metricColor(telemetry.jitterMs, 15, 35), [telemetry.jitterMs]);
  const lossColor = useMemo(() => metricColor(telemetry.lossRate * 100, 2, 8), [telemetry.lossRate]);
  const bandwidthColor = useMemo(
    () => metricColor(telemetry.bandwidthKbps, 2000, 1000, true),
    [telemetry.bandwidthKbps]
  );

  return (
    <div style={{ minHeight: "100vh", padding: 16, background: "linear-gradient(160deg, #f8fafc 0%, #eef2ff 100%)" }}>
      <div style={{ margin: "0 auto", maxWidth: 1360 }}>
        <h2 style={{ margin: 0 }}>机器人远程操控仿真与可视化平台</h2>
        <p style={{ marginTop: 8, marginBottom: 18, color: "#334155" }}>
          WebSocket状态：{connected} | 序号：#{telemetry.seq}
        </p>

        <Grid container spacing={2}>
          <Grid item xs={12} md={3}>
            <Card style={{ padding: 16, height: "100%" }}>
              <h3 style={{ marginTop: 0 }}>控制按钮</h3>
              <div style={{ display: "grid", gap: 10 }}>
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

                <Button variant="text" color="error" onClick={reset}>复位</Button>
                {NETWORK_PROFILES.map((profile) => (
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
            <Card style={{ padding: 16, height: "100%" }}>
              <h3 style={{ marginTop: 0 }}>3D机械臂</h3>
              <p style={{ marginTop: -6, marginBottom: 10, color: "#475569", fontSize: 12 }}>
                {hasRobotModelAsset
                  ? modelLoadFailed
                    ? "真实模型加载超时或失败，已回退内置几何机械臂"
                    : "已加载真实模型资产（ur5e OBJ）"
                  : "未检测到模型资产，使用内置几何机械臂"}
              </p>
              <div style={{ height: 420, borderRadius: 12, overflow: "hidden", background: "#dbeafe" }}>
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
                    <ModelErrorBoundary fallback={<Arm3D joints={joints} grip={0.7} />} onError={() => setModelLoadFailed(true)}>
                      <Suspense fallback={<Arm3D joints={joints} grip={0.7} />}>
                        <RobotModelAsset joints={joints} onReady={() => setModelReady(true)} />
                      </Suspense>
                    </ModelErrorBoundary>
                  ) : (
                    <Arm3D joints={joints} grip={0.7} />
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

          <Grid item xs={12} md={4}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={12}>
                <Card style={{ padding: 16 }}>
                  <p style={{ margin: 0, color: "#475569" }}>时延</p>
                  <div style={{ fontSize: 38, fontWeight: 700, color: latencyColor }}>{telemetry.latencyMs.toFixed(1)} ms</div>
                </Card>
              </Grid>
              <Grid item xs={12} sm={6} md={12}>
                <Card style={{ padding: 16 }}>
                  <p style={{ margin: 0, color: "#475569" }}>抖动</p>
                  <div style={{ fontSize: 38, fontWeight: 700, color: jitterColor }}>{telemetry.jitterMs.toFixed(1)} ms</div>
                </Card>
              </Grid>
              <Grid item xs={12} sm={6} md={12}>
                <Card style={{ padding: 16 }}>
                  <p style={{ margin: 0, color: "#475569" }}>丢包率</p>
                  <div style={{ fontSize: 38, fontWeight: 700, color: lossColor }}>{(telemetry.lossRate * 100).toFixed(2)}%</div>
                  <p style={{ margin: "6px 0 0", color: "#64748b", fontSize: 12 }}>
                    后端观测：{(telemetry.backendLossRate * 100).toFixed(2)}%
                  </p>
                </Card>
              </Grid>
              <Grid item xs={12} sm={6} md={12}>
                <Card style={{ padding: 16 }}>
                  <p style={{ margin: 0, color: "#475569" }}>带宽</p>
                  <div style={{ fontSize: 38, fontWeight: 700, color: bandwidthColor }}>{telemetry.bandwidthKbps.toFixed(0)} kbps</div>
                  <p style={{ margin: "6px 0 0", color: "#64748b", fontSize: 12 }}>
                    队列积压：
                    <span
                      style={{
                        color: telemetry.queuePending > 5 ? "#dc2626" : "#64748b",
                        fontWeight: telemetry.queuePending > 5 ? 700 : 400,
                        marginLeft: 4,
                      }}
                    >
                      {telemetry.queuePending}
                    </span>
                  </p>
                </Card>
              </Grid>
            </Grid>
          </Grid>
        </Grid>
      </div>
    </div>
  );
}

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Grid, Slider } from "@mui/material";
import { Canvas } from "@react-three/fiber";
import { ContactShadows, Environment, OrbitControls, PerspectiveCamera, useGLTF } from "@react-three/drei";
import type { Object3D } from "three";

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

const NETWORK_PROFILES: NetworkProfile[] = [
  { key: "good", label: "良好网络", delayMs: 25, jitterMs: 3, lossRate: 0.001, bandwidthKbps: 12000 },
  { key: "mid", label: "中等拥塞", delayMs: 700, jitterMs: 220, lossRate: 0.12, bandwidthKbps: 320 },
  { key: "bad", label: "恶劣网络", delayMs: 2250, jitterMs: 750, lossRate: 0.45, bandwidthKbps: 64 },
];

const DEFAULT_JOINTS = [0.3, -0.5, 0.7, 0.2];
const ROBOT_MODEL_URL = "/assets/robot/ur5e.glb";

function isValidGlb(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  // GLB magic should be ASCII "glTF" (0x46546c67, little-endian).
  return new DataView(buffer).getUint32(0, true) === 0x46546c67;
}

function wsUrl(): string {
  const host = window.location.hostname || "localhost";
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${host}:8000/ws`;
}

function clampRad(value: number): number {
  return Math.max(-2.6, Math.min(2.6, value));
}

function degToRad(value: number): number {
  return (value * Math.PI) / 180;
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

function RobotModelAsset() {
  const { scene } = useGLTF(ROBOT_MODEL_URL);

  const cloned = useMemo<Object3D>(() => scene.clone(true), [scene]);

  return <primitive object={cloned} scale={1.25} position={[0, 0, 0]} rotation={[0, Math.PI, 0]} />;
}

export default function App() {
  const wsRef = useRef<WebSocket | null>(null);
  const cmdSeqRef = useRef(1);
  const pendingRef = useRef<Map<number, number>>(new Map());
  const sentCountRef = useRef(0);
  const ackCountRef = useRef(0);
  const lastRttRef = useRef<number | null>(null);
  const jitterEwmaRef = useRef(0);

  const [connected, setConnected] = useState("未连接");
  const [stepDeg, setStepDeg] = useState(5);
  const [grip, setGrip] = useState(0.7);
  const [joints, setJoints] = useState<number[]>(DEFAULT_JOINTS);
  const [activeProfile, setActiveProfile] = useState<string>(NETWORK_PROFILES[0].key);
  const [hasRobotModelAsset, setHasRobotModelAsset] = useState(false);
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

  const sendJoints = useCallback(
    (nextJoints: number[], steps = 8) => {
      const clamped = nextJoints.map(clampRad);
      const cmdSeq = cmdSeqRef.current++;
      const ts = Date.now();
      pendingRef.current.set(cmdSeq, ts);
      sentCountRef.current += 1;

      send({
        type: "robot_joint_control",
        cmd_seq: cmdSeq,
        client_timestamp: ts,
        payload: { target_positions: [...clamped, 0, 0, 0], steps },
      });
    },
    [send]
  );

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

  const updateJoint0 = useCallback(
    (deltaDeg: number) => {
      const next = [...joints];
      next[0] = (next[0] ?? 0) + degToRad(deltaDeg);
      sendJoints(next);
    },
    [joints, sendJoints]
  );

  const moveForward = useCallback(() => {
    const step = degToRad(stepDeg);
    sendJoints([(joints[0] ?? 0), (joints[1] ?? 0) - step, (joints[2] ?? 0) + step, (joints[3] ?? 0)]);
  }, [joints, sendJoints, stepDeg]);

  const moveBackward = useCallback(() => {
    const step = degToRad(stepDeg);
    sendJoints([(joints[0] ?? 0), (joints[1] ?? 0) + step, (joints[2] ?? 0) - step, (joints[3] ?? 0)]);
  }, [joints, sendJoints, stepDeg]);

  const grab = useCallback(() => setGrip((v) => Math.max(0.1, v - 0.2)), []);
  const release = useCallback(() => setGrip((v) => Math.min(1, v + 0.2)), []);

  const applyEeControl = useCallback(() => {
    sendEeTarget(eeTarget, eeWristPitchDeg);
  }, [eeTarget, eeWristPitchDeg, sendEeTarget]);

  const reset = useCallback(() => {
    setJoints(DEFAULT_JOINTS);
    setGrip(0.7);
    setEeTarget({ x: 0.0, y: 1.7, z: 1.6 });
    setEeWristPitchDeg(-25);
    send({ type: "robot_reset", payload: { initial_positions: [0, 0, 0, 0, 0, 0, 0] } });
  }, [send]);

  useEffect(() => {
    let disposed = false;

    const checkModelAsset = async () => {
      try {
        const response = await fetch(ROBOT_MODEL_URL, { cache: "no-store" });
        const binary = await response.arrayBuffer();
        if (!disposed) {
          setHasRobotModelAsset(response.ok && isValidGlb(binary));
        }
      } catch {
        if (!disposed) {
          setHasRobotModelAsset(false);
        }
      }
    };

    void checkModelAsset();

    return () => {
      disposed = true;
    };
  }, []);

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
        if (next.length >= 4) setJoints([next[0], next[1], next[2], next[3]]);
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
              <p style={{ marginBottom: 10 }}>步进角度：{stepDeg}°</p>
              <Slider min={1} max={20} step={1} value={stepDeg} onChange={(_, v) => setStepDeg(v as number)} />
              <div style={{ display: "grid", gap: 10 }}>
                <Button variant="contained" onClick={() => updateJoint0(stepDeg)}>关节1 +{stepDeg}°</Button>
                <Button variant="contained" onClick={() => updateJoint0(-stepDeg)}>关节1 -{stepDeg}°</Button>
                <Button variant="contained" color="success" onClick={moveForward}>向前</Button>
                <Button variant="outlined" color="success" onClick={moveBackward}>向后</Button>
                <Button variant="contained" color="warning" onClick={grab}>抓取</Button>
                <Button variant="outlined" color="warning" onClick={release}>松开</Button>

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
                {hasRobotModelAsset ? "已加载真实模型资产（ur5e.glb）" : "未检测到模型资产，使用内置几何机械臂"}
              </p>
              <div style={{ height: 420, borderRadius: 12, overflow: "hidden", background: "#dbeafe" }}>
                <Canvas
                  shadows
                  gl={{ antialias: true, powerPreference: "high-performance" }}
                  dpr={[1, 1.8]}
                >
                  <PerspectiveCamera makeDefault position={[5.8, 4.8, 6.6]} fov={52} />
                  <color attach="background" args={["#dbeafe"]} />
                  <fog attach="fog" args={["#dbeafe", 8, 18]} />

                  <ambientLight intensity={0.25} />
                  <hemisphereLight intensity={0.5} color="#f8fafc" groundColor="#94a3b8" />
                  <directionalLight
                    castShadow
                    intensity={1.5}
                    position={[5.5, 7.5, 4.5]}
                    shadow-mapSize-width={2048}
                    shadow-mapSize-height={2048}
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
                  <Environment preset="city" />

                  <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
                    <planeGeometry args={[12, 12]} />
                    <meshStandardMaterial color="#d6deea" roughness={0.78} metalness={0.08} />
                  </mesh>

                  {hasRobotModelAsset ? (
                    <Suspense fallback={null}>
                      <RobotModelAsset />
                    </Suspense>
                  ) : (
                    <Arm3D joints={joints} grip={grip} />
                  )}
                  <ContactShadows
                    position={[0, 0, 0]}
                    opacity={0.55}
                    scale={8.8}
                    blur={2.8}
                    far={3.8}
                    color="#1e293b"
                  />
                  <OrbitControls makeDefault enablePan={false} target={[0, 1.7, 0]} minDistance={4} maxDistance={12} />
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

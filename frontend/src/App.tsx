import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Grid, Slider } from "@mui/material";
import { Canvas } from "@react-three/fiber";
import { ContactShadows, Environment, OrbitControls, PerspectiveCamera } from "@react-three/drei";

type Telemetry = {
  seq: number;
  latencyMs: number;
  jitterMs: number;
  lossRate: number;
  bandwidthKbps: number;
};

const DEFAULT_JOINTS = [0.3, -0.5, 0.7, 0.2];

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

export default function App() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState("未连接");
  const [stepDeg, setStepDeg] = useState(5);
  const [grip, setGrip] = useState(0.7);
  const [joints, setJoints] = useState<number[]>(DEFAULT_JOINTS);
  const [telemetry, setTelemetry] = useState<Telemetry>({
    seq: 0,
    latencyMs: 0,
    jitterMs: 0,
    lossRate: 0,
    bandwidthKbps: 0,
  });

  const send = useCallback((payload: object) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }, []);

  const sendJoints = useCallback(
    (nextJoints: number[]) => {
      const clamped = nextJoints.map(clampRad);
      setJoints(clamped);
      send({
        type: "robot_joint_control",
        payload: { target_positions: [...clamped, 0, 0, 0], steps: 8 },
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

  const reset = useCallback(() => {
    setJoints(DEFAULT_JOINTS);
    setGrip(0.7);
    send({ type: "robot_reset", payload: { initial_positions: [0, 0, 0, 0, 0, 0, 0] } });
  }, [send]);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;

      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      setConnected("连接中");

      ws.onopen = () => setConnected("已连接");
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
          network_stats?: { avg_total_delay_ms?: number; observed_loss_rate?: number };
          network_config?: { jitter_ms?: number; bandwidth_kbps?: number };
          simulation_status?: { joint_positions?: number[] };
        };

        if (data.type !== "telemetry") return;

        setTelemetry({
          seq: data.seq ?? 0,
          latencyMs: data.network_stats?.avg_total_delay_ms ?? 0,
          jitterMs: data.network_config?.jitter_ms ?? 0,
          lossRate: data.network_stats?.observed_loss_rate ?? 0,
          bandwidthKbps: data.network_config?.bandwidth_kbps ?? 0,
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
                <Button variant="text" color="error" onClick={reset}>复位</Button>
              </div>
            </Card>
          </Grid>

          <Grid item xs={12} md={5}>
            <Card style={{ padding: 16, height: "100%" }}>
              <h3 style={{ marginTop: 0 }}>3D机械臂</h3>
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

                  <Arm3D joints={joints} grip={grip} />
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
                </Card>
              </Grid>
              <Grid item xs={12} sm={6} md={12}>
                <Card style={{ padding: 16 }}>
                  <p style={{ margin: 0, color: "#475569" }}>带宽</p>
                  <div style={{ fontSize: 38, fontWeight: 700, color: bandwidthColor }}>{telemetry.bandwidthKbps.toFixed(0)} kbps</div>
                </Card>
              </Grid>
            </Grid>
          </Grid>
        </Grid>
      </div>
    </div>
  );
}

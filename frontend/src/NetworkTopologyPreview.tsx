import { Button, Card, Grid } from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import NetworkTopologyMap, { TopologyLink, TopologyNode } from "./NetworkTopologyMap";

type NetworkProfile = "wifi" | "4g" | "5g";

type LinkSeed = {
  baseLatencyMs: number;
  baseLoss: number;
  baseJitterMs: number;
};

const BASE_TOPOLOGY_NODES: TopologyNode[] = [
  { id: "client", name: "控制端 Client", role: "sender", lat: 31.2304, lng: 121.4737 },
  { id: "edge", name: "边缘节点 Edge", role: "router", lat: 30.5728, lng: 104.0668 },
  { id: "core", name: "核心节点 Core", role: "router", lat: 39.9042, lng: 116.4074 },
  { id: "robot", name: "机器人 Robot", role: "receiver", lat: 22.5431, lng: 114.0579 },
];

const PATH_TEMPLATE = [
  { id: "client-edge", from: "client", to: "edge" },
  { id: "edge-core", from: "edge", to: "core" },
  { id: "core-robot", from: "core", to: "robot" },
] as const;

const PROFILE_SEEDS: Record<NetworkProfile, LinkSeed[]> = {
  wifi: [
    { baseLatencyMs: 26, baseLoss: 0.003, baseJitterMs: 4 },
    { baseLatencyMs: 48, baseLoss: 0.006, baseJitterMs: 6 },
    { baseLatencyMs: 38, baseLoss: 0.005, baseJitterMs: 5 },
  ],
  "4g": [
    { baseLatencyMs: 58, baseLoss: 0.014, baseJitterMs: 10 },
    { baseLatencyMs: 92, baseLoss: 0.025, baseJitterMs: 15 },
    { baseLatencyMs: 82, baseLoss: 0.019, baseJitterMs: 12 },
  ],
  "5g": [
    { baseLatencyMs: 34, baseLoss: 0.006, baseJitterMs: 5 },
    { baseLatencyMs: 56, baseLoss: 0.011, baseJitterMs: 8 },
    { baseLatencyMs: 47, baseLoss: 0.008, baseJitterMs: 7 },
  ],
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function makeLinks(profile: NetworkProfile, tick: number): TopologyLink[] {
  const seeds = PROFILE_SEEDS[profile];
  const phase = tick * 0.42;

  return PATH_TEMPLATE.map((link, index) => {
    const seed = seeds[index];
    const wave = Math.sin(phase + index * 0.78);
    const wave2 = Math.cos(phase * 0.9 + index * 0.53);

    return {
      id: link.id,
      from: link.from,
      to: link.to,
      latencyMs: clamp(seed.baseLatencyMs + wave * 11 + wave2 * 5, 8, 180),
      packetLoss: clamp(seed.baseLoss + wave * 0.01 + wave2 * 0.004, 0.001, 0.12),
      jitterMs: clamp(seed.baseJitterMs + wave * 3.5 + wave2 * 1.3, 1, 40),
    };
  });
}

function makeNodesWithRouterStatus(links: TopologyLink[], tick: number): TopologyNode[] {
  const edgeIn = links.find((item) => item.id === "client-edge");
  const edgeOut = links.find((item) => item.id === "edge-core");
  const coreIn = links.find((item) => item.id === "edge-core");
  const coreOut = links.find((item) => item.id === "core-robot");

  const edgeDelay = ((edgeIn?.latencyMs ?? 24) + (edgeOut?.latencyMs ?? 34)) * 0.5;
  const coreDelay = ((coreIn?.latencyMs ?? 32) + (coreOut?.latencyMs ?? 36)) * 0.5;
  const edgeLoss = ((edgeIn?.packetLoss ?? 0.004) + (edgeOut?.packetLoss ?? 0.006)) * 0.5;
  const coreLoss = ((coreIn?.packetLoss ?? 0.005) + (coreOut?.packetLoss ?? 0.007)) * 0.5;

  const edgeBusy = clamp(20 + edgeDelay * 0.72 + edgeLoss * 1100 + Math.sin(tick * 0.35) * 8, 6, 98);
  const coreBusy = clamp(26 + coreDelay * 0.66 + coreLoss * 1250 + Math.cos(tick * 0.3) * 9, 8, 99);

  return BASE_TOPOLOGY_NODES.map((node) => {
    if (node.id === "edge") {
      return {
        ...node,
        processingDelayMs: edgeDelay,
        busyPercent: edgeBusy,
        queueDepth: Math.round(edgeBusy / 7),
      };
    }
    if (node.id === "core") {
      return {
        ...node,
        processingDelayMs: coreDelay,
        busyPercent: coreBusy,
        queueDepth: Math.round(coreBusy / 6),
      };
    }
    return node;
  });
}

export default function NetworkTopologyPreview() {
  const [profile, setProfile] = useState<NetworkProfile>("wifi");
  const [tick, setTick] = useState(1);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((prev) => prev + 1), 1200);
    return () => window.clearInterval(timer);
  }, []);

  const links = useMemo(() => makeLinks(profile, tick), [profile, tick]);
  const nodes = useMemo(() => makeNodesWithRouterStatus(links, tick), [links, tick]);
  const routerNodes = useMemo(() => nodes.filter((item) => item.role === "router"), [nodes]);
  const totalLatency = links.reduce((sum, item) => sum + item.latencyMs, 0);
  const avgLoss = links.reduce((sum, item) => sum + item.packetLoss, 0) / links.length;

  return (
    <div style={{ minHeight: "100vh", padding: 16, background: "linear-gradient(160deg, #f8fafc 0%, #e6fffb 45%, #fef9c3 100%)" }}>
      <div style={{ margin: "0 auto", maxWidth: 1320 }}>
        <Card style={{ padding: 14, marginBottom: 12, borderRadius: 14 }}>
          <h2 style={{ margin: 0 }}>网络路径地图预览（前端独立模式）</h2>
          <p style={{ marginTop: 8, marginBottom: 0, color: "#334155" }}>
            这个页面不依赖后端，纯前端模拟链路动态，方便你先看演示效果。
          </p>
        </Card>

        <Grid container spacing={2}>
          <Grid item xs={12} md={8}>
            <NetworkTopologyMap title="控制端 -> 边缘节点 -> 核心节点 -> 机器人" nodes={nodes} links={links} height={540} />
          </Grid>

          <Grid item xs={12} md={4}>
            <Card style={{ padding: 14, borderRadius: 14 }}>
              <h3 style={{ marginTop: 0 }}>网络环境切换</h3>
              <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr 1fr" }}>
                <Button variant={profile === "wifi" ? "contained" : "outlined"} onClick={() => setProfile("wifi")}>WiFi</Button>
                <Button variant={profile === "4g" ? "contained" : "outlined"} onClick={() => setProfile("4g")}>4G</Button>
                <Button variant={profile === "5g" ? "contained" : "outlined"} onClick={() => setProfile("5g")}>5G</Button>
              </div>

              <Card variant="outlined" style={{ marginTop: 12, padding: 10 }}>
                <p style={{ margin: 0, color: "#64748b", fontSize: 12 }}>端到端总时延</p>
                <div style={{ fontSize: 34, fontWeight: 700, color: totalLatency >= 240 ? "#b91c1c" : totalLatency >= 160 ? "#b45309" : "#166534" }}>
                  {totalLatency.toFixed(1)} ms
                </div>
              </Card>

              <Card variant="outlined" style={{ marginTop: 10, padding: 10 }}>
                <p style={{ margin: 0, color: "#64748b", fontSize: 12 }}>平均丢包率</p>
                <div style={{ fontSize: 34, fontWeight: 700, color: avgLoss >= 0.04 ? "#b91c1c" : avgLoss >= 0.02 ? "#b45309" : "#166534" }}>
                  {(avgLoss * 100).toFixed(2)}%
                </div>
              </Card>

              <Card variant="outlined" style={{ marginTop: 10, padding: 10 }}>
                <p style={{ margin: "0 0 6px", color: "#334155", fontWeight: 700 }}>当前链路明细</p>
                {links.map((link) => (
                  <p key={link.id} style={{ margin: "4px 0", fontSize: 12, color: "#475569", lineHeight: 1.5 }}>
                    {link.id}: {link.latencyMs.toFixed(1)} ms | {(link.packetLoss * 100).toFixed(2)}% loss | {link.jitterMs.toFixed(1)} ms jitter
                  </p>
                ))}
              </Card>

              <Card variant="outlined" style={{ marginTop: 10, padding: 10 }}>
                <p style={{ margin: "0 0 6px", color: "#334155", fontWeight: 700 }}>路由器状态</p>
                {routerNodes.map((node) => (
                  <p key={node.id} style={{ margin: "4px 0", fontSize: 12, color: "#475569", lineHeight: 1.5 }}>
                    {node.name}: 节点时延 {(node.processingDelayMs ?? 0).toFixed(1)} ms | 繁忙度 {(node.busyPercent ?? 0).toFixed(0)}% | 排队 {node.queueDepth ?? 0}
                  </p>
                ))}
              </Card>

              <Card variant="outlined" style={{ marginTop: 10, padding: 10, background: "#f8fafc" }}>
                <p style={{ margin: "0 0 6px", color: "#334155", fontWeight: 700 }}>概念解释</p>
                <p style={{ margin: "4px 0", fontSize: 12, color: "#475569", lineHeight: 1.5 }}>
                  路由器在这里不是现实中的建筑位置，而是网络拓扑中的中转节点，用来表示数据从控制端到机器人经过了哪里。
                </p>
                <p style={{ margin: "4px 0", fontSize: 12, color: "#475569", lineHeight: 1.5 }}>
                  节点时延表示路由器处理和转发数据的时间，繁忙度表示当前节点压力，排队数表示暂时等待处理的请求数量。
                </p>
                <p style={{ margin: "4px 0", fontSize: 12, color: "#475569", lineHeight: 1.5 }}>
                  外圈颜色是为了快速识别瓶颈：越偏红，说明该节点越忙、越可能成为网络中继瓶颈。
                </p>
              </Card>
            </Card>
          </Grid>
        </Grid>
      </div>
    </div>
  );
}

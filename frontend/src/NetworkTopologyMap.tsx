import { Card } from "@mui/material";
import "leaflet/dist/leaflet.css";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from "react-leaflet";

export type TopologyNode = {
  id: string;
  name: string;
  role: "sender" | "router" | "receiver";
  lat: number;
  lng: number;
};

export type TopologyLink = {
  id: string;
  from: string;
  to: string;
  latencyMs: number;
  packetLoss: number;
  jitterMs: number;
};

type NetworkTopologyMapProps = {
  title?: string;
  nodes: TopologyNode[];
  links: TopologyLink[];
  height?: number;
};

function linkColor(latencyMs: number): string {
  if (latencyMs >= 120) return "#b91c1c";
  if (latencyMs >= 70) return "#b45309";
  return "#166534";
}

function nodeColor(role: TopologyNode["role"]): string {
  if (role === "sender") return "#2563eb";
  if (role === "receiver") return "#7c3aed";
  return "#0891b2";
}

function nodeRadius(role: TopologyNode["role"]): number {
  if (role === "router") return 8;
  return 9;
}

export default function NetworkTopologyMap({
  title = "网络路径地图",
  nodes,
  links,
  height = 420,
}: NetworkTopologyMapProps) {
  const centerLat = nodes.reduce((sum, n) => sum + n.lat, 0) / Math.max(1, nodes.length);
  const centerLng = nodes.reduce((sum, n) => sum + n.lng, 0) / Math.max(1, nodes.length);

  return (
    <Card style={{ borderRadius: 14, padding: 12 }}>
      <h3 style={{ marginTop: 0, marginBottom: 8 }}>{title}</h3>
      <p style={{ margin: "0 0 10px", color: "#475569", fontSize: 12 }}>
        绿色代表低时延，橙色代表中时延，红色代表高时延；虚线表示丢包偏高。
      </p>

      <div style={{ position: "relative", height, borderRadius: 12, overflow: "hidden" }}>
        <MapContainer center={[centerLat, centerLng]} zoom={4} style={{ height: "100%", width: "100%" }}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {links.map((link) => {
            const from = nodes.find((node) => node.id === link.from);
            const to = nodes.find((node) => node.id === link.to);
            if (!from || !to) return null;

            return (
              <Polyline
                key={link.id}
                positions={[
                  [from.lat, from.lng],
                  [to.lat, to.lng],
                ]}
                pathOptions={{
                  color: linkColor(link.latencyMs),
                  weight: 5,
                  opacity: 0.9,
                  dashArray: link.packetLoss >= 0.03 ? "8 10" : undefined,
                }}
              >
                <Tooltip sticky>
                  {from.name}
                  {" -> "}
                  {to.name}
                  <br />
                  时延: {link.latencyMs.toFixed(1)} ms
                  <br />
                  丢包: {(link.packetLoss * 100).toFixed(2)}%
                  <br />
                  抖动: {link.jitterMs.toFixed(1)} ms
                </Tooltip>
              </Polyline>
            );
          })}

          {nodes.map((node) => (
            <CircleMarker
              key={node.id}
              center={[node.lat, node.lng]}
              radius={nodeRadius(node.role)}
              pathOptions={{
                color: "#ffffff",
                weight: 2,
                fillColor: nodeColor(node.role),
                fillOpacity: 0.95,
              }}
            >
              <Tooltip direction="top" offset={[0, -4]}>
                {node.name}
              </Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>

        <div
          style={{
            position: "absolute",
            right: 12,
            bottom: 12,
            background: "rgba(15, 23, 42, 0.88)",
            color: "#e2e8f0",
            borderRadius: 10,
            padding: "8px 10px",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          Sender: 蓝色点
          <br />
          Router: 青色点
          <br />
          Receiver: 紫色点
        </div>
      </div>
    </Card>
  );
}

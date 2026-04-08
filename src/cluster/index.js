/**
 * Cluster bootstrap – called once at server startup.
 *
 * What this module does:
 *   1. Starts the WebSocket server on the same HTTP server used by Express.
 *   2. Starts a UDP announcer so this node responds to DISCOVER broadcasts.
 *   3. Registers this node with its own coordinator so it participates in
 *      inference when no remote peers are found.
 *   4. Discovers peer nodes:
 *        a. If COORDINATOR_HOST is set, connects to that host as a worker.
 *        b. Otherwise, scans the local network (UDP broadcast, then TCP scan)
 *           and connects to every discovered peer.
 *   5. Exposes getCoordinator() for use by the inference layer.
 *
 * Environment variables consumed:
 *   CLUSTER_PORT        WebSocket port for cluster traffic.       Default: 3001
 *   NODE_GPU_MEMORY_GB  GPU memory this node contributes (GB).    Default: 8
 *   NODE_OLLAMA_PORT    Local Ollama HTTP port.                   Default: 11434
 *   COORDINATOR_HOST    Explicit coordinator address (ws:// or host).
 *                       When set, this node skips discovery and acts as a
 *                       pure worker.
 *
 * Exports:
 *   initCluster(httpServer) → Promise<{ coordinator, wss }>
 *   getCoordinator()        → ClusterCoordinator | null
 */

import { randomUUID } from "crypto";
import { WebSocket } from "ws";

import { ClusterCoordinator } from "./coordinator.js";
import { startWsServer, wsSend } from "./ws-server.js";
import {
  discoverNodes,
  createUdpAnnouncer,
  getLocalIPv4Addresses,
} from "./discovery.js";

/** @type {ClusterCoordinator|null} */
let _coordinator = null;

/** @returns {ClusterCoordinator|null} */
export function getCoordinator() {
  return _coordinator;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the primary non-loopback IPv4 address of this machine. */
function getLocalIp() {
  return getLocalIPv4Addresses()[0]?.address ?? "127.0.0.1";
}

// ── Worker-side inference handler ─────────────────────────────────────────────

/**
 * Called when a coordinator sends an INFERENCE_REQUEST to this node.
 * Runs the prompt against the local Ollama HTTP API and sends the result back.
 *
 * @param {WebSocket} ws            Connection back to the coordinator.
 * @param {object}    msg           Parsed INFERENCE_REQUEST message.
 * @param {number}    ollamaPort    Local Ollama port.
 */
async function handleWorkerInference(ws, msg, ollamaPort) {
  const { requestId, model, messages, options } = msg;
  try {
    const res = await fetch(`http://localhost:${ollamaPort}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, options, stream: false }),
    });

    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}`);
    }

    const data = await res.json();
    const content = data.message?.content ?? "";
    wsSend(ws, { type: "INFERENCE_RESPONSE", requestId, content, done: true });
  } catch (err) {
    console.error("[cluster] Worker inference error:", err.message);
    wsSend(ws, {
      type: "INFERENCE_RESPONSE",
      requestId,
      error: err.message,
      done: true,
    });
  }
}

// ── Peer connection ───────────────────────────────────────────────────────────

/**
 * Opens a WebSocket connection from this node to a coordinator at `wsUrl`.
 * Automatically reconnects if the connection drops.
 *
 * @param {string} wsUrl         WebSocket URL of the coordinator.
 * @param {string} nodeId        This node's unique identifier.
 * @param {number} ollamaPort    Local Ollama port.
 * @param {number} gpuMemoryGB   GPU memory this node contributes.
 */
function connectToPeer(wsUrl, nodeId, ollamaPort, gpuMemoryGB) {
  let ws;
  let heartbeatTimer;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      console.log(`[cluster] Connected to peer coordinator at ${wsUrl}`);
      wsSend(ws, {
        type: "REGISTER",
        nodeId,
        role: "worker",
        host: getLocalIp(),
        ollamaPort,
        gpuMemoryGB,
      });

      // Send periodic heartbeats so the coordinator knows we are alive
      heartbeatTimer = setInterval(
        () => wsSend(ws, { type: "HEARTBEAT", nodeId }),
        10_000
      );
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "REGISTERED") {
        console.log(
          `[cluster] Registered with peer coordinator (id=${msg.nodeId})`
        );
      } else if (msg.type === "ASSIGN_LAYERS") {
        console.log(
          `[cluster] Layer assignment - model=${msg.model}  ` +
            `layers ${msg.layerStart}-${msg.layerEnd}/${msg.totalLayers}`
        );
        // Acknowledge so the coordinator can record the accepted assignment
        wsSend(ws, {
          type: "LAYER_ACK",
          nodeId,
          layerStart: msg.layerStart,
          layerEnd: msg.layerEnd,
        });
      } else if (msg.type === "INFERENCE_REQUEST") {
        handleWorkerInference(ws, msg, ollamaPort);
      } else if (msg.type === "CLUSTER_STATE") {
        console.log(
          "[cluster] Cluster state update:",
          JSON.stringify(msg.nodes)
        );
      } else {
        console.warn(`[cluster] Unknown peer message type: ${msg.type}`);
      }
    });

    ws.on("close", () => {
      clearInterval(heartbeatTimer);
      console.warn(
        `[cluster] Connection to ${wsUrl} closed – reconnecting in 10 s`
      );
      setTimeout(connect, 10_000);
    });

    ws.on("error", (err) => {
      console.error(`[cluster] WebSocket error (${wsUrl}):`, err.message);
    });
  }

  connect();
}

// ── Public bootstrap ──────────────────────────────────────────────────────────

/**
 * Initialises the cluster layer for this server instance.
 *
 * @param {import('http').Server} httpServer  The running Express http.Server.
 * @returns {Promise<{ coordinator: ClusterCoordinator, wss: import('ws').WebSocketServer }>}
 */
export async function initCluster(httpServer) {
  const clusterPort = Number(process.env.CLUSTER_PORT ?? 3001);
  const ollamaPort = Number(process.env.NODE_OLLAMA_PORT ?? 11434);
  const gpuMemoryGB = Number(process.env.NODE_GPU_MEMORY_GB ?? 8);
  const nodeId = randomUUID();
  const localIp = getLocalIp();

  console.log(
    `[cluster] Initialising node  id=${nodeId}  ip=${localIp}  ` +
      `gpu=${gpuMemoryGB} GB  ollamaPort=${ollamaPort}`
  );

  // Start coordinator and WebSocket server
  _coordinator = new ClusterCoordinator();
  const wss = startWsServer(httpServer, _coordinator);

  // Start UDP announcer so peers can discover us
  createUdpAnnouncer(clusterPort);

  // Register this node with its own coordinator (self-participation)
  _coordinator.registerNode(
    // Local "virtual" socket – the local node doesn't need real WS messages
    { readyState: WebSocket.OPEN, send: () => {} },
    {
      nodeId,
      role: "coordinator",
      host: localIp,
      ollamaPort,
      gpuMemoryGB,
    }
  );

  const coordinatorHost = process.env.COORDINATOR_HOST;

  if (coordinatorHost) {
    // Explicit coordinator configured: act as a worker only
    const wsUrl = coordinatorHost.startsWith("ws")
      ? coordinatorHost
      : `ws://${coordinatorHost}:${clusterPort}`;
    console.log(`[cluster] Connecting to configured coordinator: ${wsUrl}`);
    connectToPeer(wsUrl, nodeId, ollamaPort, gpuMemoryGB);
  } else {
    // Auto-discover peers on the local network
    console.log("[cluster] Scanning local network for peer nodes…");
    try {
      const peers = await discoverNodes(clusterPort, 3000);
      if (peers.length > 0) {
        console.log(
          `[cluster] Discovered ${peers.length} peer(s): ${peers
            .map((p) => p.host)
            .join(", ")}`
        );
        for (const peer of peers) {
          const wsUrl = `ws://${peer.host}:${peer.clusterPort}`;
          connectToPeer(wsUrl, nodeId, ollamaPort, gpuMemoryGB);
        }
      } else {
        console.log(
          "[cluster] No peers found – running as a single-node cluster"
        );
      }
    } catch (err) {
      console.error("[cluster] Discovery error:", err.message);
    }
  }

  console.log(
    "[cluster] Ready – WebSocket endpoint available on the Express HTTP server"
  );

  return { coordinator: _coordinator, wss };
}

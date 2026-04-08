/**
 * WebSocket server for cluster inter-node communication.
 *
 * Attaches to the running Express HTTP server so that the cluster WS endpoint
 * shares the same port as the REST API (no extra firewall rules needed).
 *
 * Message protocol – all payloads are JSON strings.
 *
 * Client → Server:
 *   { type: "REGISTER",           nodeId, role, host, ollamaPort, gpuMemoryGB }
 *   { type: "HEARTBEAT",          nodeId }
 *   { type: "INFERENCE_RESPONSE", requestId, content?, error?, done }
 *   { type: "LAYER_ACK",          nodeId, layerStart, layerEnd }
 *
 * Server → Client:
 *   { type: "REGISTERED",         nodeId, role }
 *   { type: "ASSIGN_LAYERS",      model, layerStart, layerEnd, totalLayers, nextNodeUrl }
 *   { type: "INFERENCE_REQUEST",  requestId, model, messages, options }
 *   { type: "CLUSTER_STATE",      nodes }
 *
 * Exports:
 *   startWsServer(httpServer, coordinator) → WebSocketServer
 *   wsSend(ws, msg)
 */

import { WebSocketServer, WebSocket } from "ws";

/**
 * Attaches a WebSocket server to an existing HTTP(S) server instance.
 *
 * @param {import('http').Server} httpServer
 * @param {import('./coordinator.js').ClusterCoordinator} coordinator
 * @returns {WebSocketServer}
 */
export function startWsServer(httpServer, coordinator) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws, req) => {
    const remoteIp =
      req.socket.remoteAddress?.replace("::ffff:", "") ?? "unknown";
    console.log(`[cluster] New WebSocket connection from ${remoteIp}`);

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        // Silently discard malformed frames
        return;
      }

      if (msg.type === "REGISTER") {
        coordinator.registerNode(ws, {
          ...msg,
          // Prefer the IP carried in the message; fall back to socket IP
          host: msg.host ?? remoteIp,
        });
      } else if (msg.type === "HEARTBEAT") {
        coordinator.handleHeartbeat(msg.nodeId);
      } else if (msg.type === "INFERENCE_RESPONSE") {
        coordinator.handleInferenceResponse(msg);
      } else if (msg.type === "LAYER_ACK") {
        coordinator.handleLayerAck(msg);
      } else {
        console.warn(`[cluster] Received unknown WS message type: ${msg.type}`);
      }
    });

    ws.on("close", () => {
      coordinator.unregisterNode(ws);
    });

    ws.on("error", (err) => {
      console.error("[cluster] WebSocket error:", err.message);
    });
  });

  return wss;
}

/**
 * Sends a JSON-serialised message over a WebSocket.
 * No-ops silently if the socket is not in the OPEN state.
 *
 * @param {WebSocket} ws
 * @param {object} msg
 */
export function wsSend(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

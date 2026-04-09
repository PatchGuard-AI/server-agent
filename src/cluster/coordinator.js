/**
 * Cluster coordinator for distributed Ollama inference.
 *
 * Responsibilities:
 *   - Maintains a registry of connected worker nodes.
 *   - Assigns contiguous model-layer ranges to each worker so that the full
 *     model is spread across the available GPU memory of the cluster.
 *   - Orchestrates pipeline inference: a request is dispatched to the first
 *     node via WebSocket; that node runs local Ollama and returns its result
 *     to the coordinator, which resolves the pending Promise.
 *   - Prunes nodes that stop sending heartbeats.
 *
 * Layer-count values below are approximations from published architecture
 * details and are used only for the layer-assignment display; they do not
 * affect the correctness of Ollama inference calls.
 *
 * Exports:
 *   ClusterCoordinator  (class)
 */

import { randomUUID } from "crypto";
import { wsSend } from "./ws-server.js";

/** Approximate transformer layer counts per model family. */
const MODEL_LAYER_COUNTS = {
  "qwen3-coder:30b": 64,
  "codellama:70b": 80,
  "qwen3-coder:480b": 128,
};

function getLayerCount(model) {
  return MODEL_LAYER_COUNTS[model] ?? 64;
}

/**
 * @typedef {{
 *   nodeId:      string,
 *   role:        string,
 *   host:        string,
 *   ollamaPort:  number,
 *   gpuMemoryGB: number,
 *   rpcPort:     number,
 *   ws:          import('ws').WebSocket,
 *   lastSeen:    number,
 *   layerStart:  number|null,
 *   layerEnd:    number|null,
 *   ollamaUrl:   string
 * }} NodeRecord
 *
 * @typedef {{ resolve: (s:string) => void, reject: (e:Error) => void }} PendingRequest
 */

export class ClusterCoordinator {
  /**
   * @param {object} [opts]
   * @param {import('./ollama-manager.js').OllamaManager|null} [opts.ollamaManager]
   *   When provided, the coordinator will call `scheduleRestart` on it whenever
   *   the set of registered RPC workers changes so that Ollama's
   *   `OLLAMA_RPC_SERVERS` is kept in sync with the live cluster topology.
   */
  constructor({ ollamaManager = null } = {}) {
    /** @type {Map<string, NodeRecord>} nodeId → record */
    this._nodes = new Map();
    /** @type {Map<import('ws').WebSocket, string>} ws → nodeId */
    this._wsToId = new Map();
    /** @type {Map<string, PendingRequest>} requestId → pending */
    this._pending = new Map();
    /** @type {import('./ollama-manager.js').OllamaManager|null} */
    this._ollamaManager = ollamaManager;

    // Prune nodes that have not sent a heartbeat in 30 s
    this._pruneTimer = setInterval(() => this._pruneStaleNodes(), 15_000);
  }

  // ── Node registry ───────────────────────────────────────────────────────────

  /**
   * Registers a newly connected node.
   * @param {import('ws').WebSocket} ws
   * @param {object} msg  Parsed REGISTER message payload.
   */
  registerNode(ws, msg) {
    const {
      nodeId,
      role = "worker",
      host,
      ollamaPort = 11434,
      gpuMemoryGB = 8,
      rpcPort = 0,
    } = msg;

    if (!nodeId) {
      console.warn("[coordinator] REGISTER message missing nodeId – ignored");
      return;
    }

    const record = {
      nodeId,
      role,
      host,
      ollamaPort: Number(ollamaPort),
      gpuMemoryGB: Number(gpuMemoryGB),
      rpcPort: Number(rpcPort),
      ws,
      lastSeen: Date.now(),
      layerStart: null,
      layerEnd: null,
      ollamaUrl: `http://${host}:${Number(ollamaPort)}`,
    };

    this._nodes.set(nodeId, record);
    this._wsToId.set(ws, nodeId);

    console.log(
      `[coordinator] Node registered: ${nodeId}  host=${host}  gpu=${gpuMemoryGB} GB` +
        (record.rpcPort ? `  rpcPort=${record.rpcPort}` : "")
    );

    wsSend(ws, { type: "REGISTERED", nodeId, role });

    // Re-distribute layers now that the pool has changed
    this._assignLayers();

    // Notify the OllamaManager so it can restart with the updated RPC server list
    this._notifyOllamaManager();
  }

  /**
   * Removes a node when its WebSocket disconnects.
   * @param {import('ws').WebSocket} ws
   */
  unregisterNode(ws) {
    const nodeId = this._wsToId.get(ws);
    if (!nodeId) {
      return;
    }
    this._wsToId.delete(ws);
    this._nodes.delete(nodeId);
    console.log(`[coordinator] Node disconnected: ${nodeId}`);
    this._assignLayers();
    this._notifyOllamaManager();
  }

  /** @param {string} nodeId */
  handleHeartbeat(nodeId) {
    const node = this._nodes.get(nodeId);
    if (node) {
      node.lastSeen = Date.now();
    }
  }

  /** @param {{ nodeId: string, layerStart: number, layerEnd: number }} msg */
  handleLayerAck(msg) {
    const node = this._nodes.get(msg.nodeId);
    if (node) {
      node.layerStart = msg.layerStart;
      node.layerEnd = msg.layerEnd;
    }
  }

  // ── Layer assignment ─────────────────────────────────────────────────────────

  /**
   * (Re-)distributes model layers across all registered nodes proportionally
   * to each node's reported GPU memory.  Called whenever the node pool changes.
   */
  _assignLayers() {
    const nodes = [...this._nodes.values()];
    if (nodes.length === 0) {
      return;
    }

    for (const model of Object.keys(MODEL_LAYER_COUNTS)) {
      this._assignModelLayers(model, nodes);
    }
  }

  /**
   * Sends ASSIGN_LAYERS messages for one model to every node.
   * @param {string} model
   * @param {NodeRecord[]} nodes
   */
  _assignModelLayers(model, nodes) {
    const totalLayers = getLayerCount(model);
    const totalGPU = nodes.reduce((s, n) => s + n.gpuMemoryGB, 0);
    const clusterPort = process.env.CLUSTER_PORT ?? 3001;

    let layerStart = 0;
    nodes.forEach((node, idx) => {
      const isLast = idx === nodes.length - 1;
      const fraction =
        totalGPU > 0 ? node.gpuMemoryGB / totalGPU : 1 / nodes.length;
      const proposed =
        layerStart + Math.max(1, Math.round(totalLayers * fraction));
      const layerEnd = isLast ? totalLayers : Math.min(proposed, totalLayers);

      const nextNode = nodes[idx + 1] ?? null;
      const nextNodeUrl = nextNode
        ? `ws://${nextNode.host}:${clusterPort}`
        : null;

      wsSend(node.ws, {
        type: "ASSIGN_LAYERS",
        model,
        layerStart,
        layerEnd,
        totalLayers,
        nextNodeUrl,
      });

      layerStart = layerEnd;
    });
  }

  // ── Inference orchestration ──────────────────────────────────────────────────

  /**
   * Returns the ordered list of Ollama HTTP base URLs for the inference
   * pipeline of the given model.  The list is in node-registration order.
   * @returns {string[]}
   */
  getPipelineUrls() {
    return [...this._nodes.values()].map((n) => n.ollamaUrl);
  }

  /**
   * Returns `host:rpcPort` strings for every node that has an RPC port
   * configured.  These are passed to the OllamaManager (and indirectly to
   * `OLLAMA_RPC_SERVERS`) so the coordinator's Ollama instance can distribute
   * model layers across the cluster.
   *
   * Coordinator-role nodes are excluded because the coordinator's Ollama is the
   * RPC *client* (head node) that sends compute to the workers – it must not
   * appear in its own `OLLAMA_RPC_SERVERS` list, which would create a loop.
   * Worker nodes with `rpcPort > 0` are the RPC *servers* that the coordinator
   * offloads model layers to.
   *
   * @returns {string[]}  e.g. ["192.168.1.2:12434", "192.168.1.3:12434"]
   */
  getRpcServers() {
    return [...this._nodes.values()]
      .filter((n) => n.role !== "coordinator" && n.rpcPort > 0)
      .map((n) => `${n.host}:${n.rpcPort}`);
  }

  /**
   * Dispatches a chat-inference request to the first registered node and
   * waits for its INFERENCE_RESPONSE.
   *
   * @param {{ model: string, messages: object[], options: object }} request
   * @returns {Promise<string>} The generated text content.
   */
  async dispatchInference({ model, messages, options }) {
    const nodes = [...this._nodes.values()];
    if (nodes.length === 0) {
      throw new Error("No cluster nodes are available for inference");
    }

    const requestId = randomUUID();
    const firstNode = nodes[0];

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(requestId);
        reject(
          new Error(`Inference request ${requestId} timed out after 120 s`)
        );
      }, 120_000);

      this._pending.set(requestId, {
        resolve: (content) => {
          clearTimeout(timeout);
          this._pending.delete(requestId);
          resolve(content);
        },
        reject: (err) => {
          clearTimeout(timeout);
          this._pending.delete(requestId);
          reject(err);
        },
      });

      wsSend(firstNode.ws, {
        type: "INFERENCE_REQUEST",
        requestId,
        model,
        messages,
        options,
      });
    });
  }

  /**
   * Resolves or rejects the pending Promise for a completed inference request.
   * @param {{ requestId: string, content?: string, error?: string }} msg
   */
  handleInferenceResponse({ requestId, content, error }) {
    const pending = this._pending.get(requestId);
    if (!pending) {
      return;
    }
    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(content ?? "");
    }
  }

  // ── Housekeeping ─────────────────────────────────────────────────────────────

  _pruneStaleNodes() {
    const cutoff = Date.now() - 30_000;
    for (const [id, node] of this._nodes) {
      if (node.lastSeen < cutoff) {
        console.warn(`[coordinator] Pruning stale node: ${id}`);
        this._nodes.delete(id);
        this._wsToId.delete(node.ws);
        this._assignLayers();
        this._notifyOllamaManager();
      }
    }
  }

  /** Returns a plain-object summary of the current cluster state. */
  getState() {
    return [...this._nodes.values()].map(
      ({ nodeId, host, gpuMemoryGB, rpcPort, layerStart, layerEnd, role }) => ({
        nodeId,
        host,
        gpuMemoryGB,
        rpcPort,
        layerStart,
        layerEnd,
        role,
      })
    );
  }

  /** Cleans up the internal prune timer (useful in tests). */
  destroy() {
    clearInterval(this._pruneTimer);
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /**
   * Notifies the OllamaManager (if one is configured) to schedule a restart
   * with the current set of RPC worker endpoints.
   */
  _notifyOllamaManager() {
    if (!this._ollamaManager) {
      return;
    }
    const rpcServers = this.getRpcServers();
    this._ollamaManager.scheduleRestart(rpcServers);
  }
}

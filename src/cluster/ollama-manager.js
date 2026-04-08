/**
 * OllamaManager – manages the local Ollama process with dynamic RPC configuration.
 *
 * When a cluster has multiple nodes, each node should be running Ollama with an
 * RPC port exposed (`OLLAMA_RPC_PORT`).  The coordinator node needs its Ollama
 * started with `OLLAMA_RPC_SERVERS` pointing at every worker's RPC endpoint so
 * that model layers are automatically distributed across all available GPUs.
 *
 * This module handles that lifecycle:
 *   - On first call to `start()`, spawns `ollama serve` with the supplied
 *     environment overrides.
 *   - `scheduleRestart(rpcServers)` debounces rapid topology changes (e.g. many
 *     workers joining within a few seconds) into a single restart, minimising
 *     disruption to in-flight requests.
 *   - `stop()` gracefully shuts the process down (SIGTERM → SIGKILL after 10 s).
 *
 * Environment variables consumed:
 *   OLLAMA_MANAGE          Set to "true" to enable subprocess management.
 *   OLLAMA_BIN             Path to the ollama binary.  Default: "ollama".
 *   NODE_OLLAMA_PORT       Port for the Ollama HTTP API.   Default: 11434.
 *   NODE_OLLAMA_RPC_PORT   Port to expose as an RPC worker. Default: 0 (disabled).
 *
 * Exports:
 *   OllamaManager  (class)
 */

import { spawn } from "child_process";

/** Milliseconds to wait after the last topology change before restarting. */
const RESTART_DEBOUNCE_MS = 5_000;

export class OllamaManager {
  /**
   * @param {object} opts
   * @param {number} [opts.ollamaPort=11434]  HTTP API port for Ollama.
   * @param {number} [opts.rpcPort=0]         RPC worker port (0 = disabled).
   * @param {string} [opts.ollamaBin='ollama'] Path to the ollama binary.
   */
  constructor({ ollamaPort = 11434, rpcPort = 0, ollamaBin = "ollama" } = {}) {
    this._ollamaPort = ollamaPort;
    this._rpcPort = rpcPort;
    this._ollamaBin = ollamaBin;
    /** @type {import('child_process').ChildProcess|null} */
    this._process = null;
    this._restartTimer = null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Spawns `ollama serve` with the supplied RPC servers list.
   * If `rpcServers` is non-empty, sets `OLLAMA_RPC_SERVERS` so that Ollama
   * distributes model layers across those workers automatically.
   *
   * @param {string[]} [rpcServers=[]]  e.g. ["192.168.1.2:12434", "192.168.1.3:12434"]
   */
  start(rpcServers = []) {
    const env = { ...process.env };
    env.OLLAMA_HOST = `0.0.0.0:${this._ollamaPort}`;

    if (this._rpcPort > 0) {
      env.OLLAMA_RPC_PORT = String(this._rpcPort);
    }

    if (rpcServers.length > 0) {
      env.OLLAMA_RPC_SERVERS = rpcServers.join(",");
      console.log(
        `[ollama-manager] Starting Ollama with ${rpcServers.length} RPC worker(s): ` +
          rpcServers.join(", ")
      );
    } else {
      delete env.OLLAMA_RPC_SERVERS;
      console.log("[ollama-manager] Starting Ollama (no RPC workers yet)");
    }

    this._process = spawn(this._ollamaBin, ["serve"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    this._process.stdout?.on("data", (d) =>
      process.stdout.write(`[ollama] ${d}`)
    );
    this._process.stderr?.on("data", (d) =>
      process.stderr.write(`[ollama] ${d}`)
    );

    this._process.on("exit", (code, signal) => {
      // Only warn for unexpected exits (not our own SIGTERM).
      if (signal !== "SIGTERM" && code !== 0 && code !== null) {
        console.warn(
          "[ollama-manager] Ollama exited unexpectedly " +
            `(code=${code} signal=${signal})`
        );
      }
      this._process = null;
    });

    this._process.on("error", (err) => {
      console.error(
        "[ollama-manager] Failed to spawn Ollama binary " +
          `('${this._ollamaBin}'): ${err.message}. ` +
          "Ensure Ollama is installed and OLLAMA_BIN is set correctly."
      );
      this._process = null;
    });
  }

  /**
   * Schedules a restart with an updated RPC servers list.
   * Consecutive calls within RESTART_DEBOUNCE_MS are coalesced into one restart,
   * which avoids thrashing when many workers join the cluster quickly.
   *
   * @param {string[]} rpcServers
   */
  scheduleRestart(rpcServers) {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
    }
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.restart(rpcServers).catch((err) => {
        console.error(
          "[ollama-manager] Scheduled restart failed:",
          err.message
        );
      });
    }, RESTART_DEBOUNCE_MS);
    console.log(
      `[ollama-manager] Restart scheduled in ${RESTART_DEBOUNCE_MS / 1000} s ` +
        `(RPC workers: ${rpcServers.length})`
    );
  }

  /**
   * Immediately stops and re-starts Ollama with the new RPC servers list.
   * @param {string[]} rpcServers
   */
  async restart(rpcServers) {
    console.log(
      "[ollama-manager] Restarting Ollama to apply updated RPC server list..."
    );
    await this.stop();
    this.start(rpcServers);
  }

  /**
   * Gracefully terminates the managed Ollama process.
   * Sends SIGTERM and waits up to 10 s before escalating to SIGKILL.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      if (!this._process) {
        return resolve();
      }
      const proc = this._process;
      const forceKill = setTimeout(() => {
        proc.kill("SIGKILL");
      }, 10_000);
      proc.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
      proc.kill("SIGTERM");
    });
  }

  // ── Accessors ────────────────────────────────────────────────────────────────

  /** @returns {boolean} */
  isRunning() {
    return this._process !== null && !this._process.killed;
  }
}

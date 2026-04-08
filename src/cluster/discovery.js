/**
 * Cluster node discovery for distributed inference.
 *
 * Discovers other server-agent nodes on the local network using two strategies:
 *   1. UDP broadcast – fastest: sends a DISCOVER datagram on every local subnet's
 *      broadcast address and collects ANNOUNCE responses within a time window.
 *   2. TCP subnet scan – fallback: probes every host in each /24 subnet for
 *      an open CLUSTER_PORT connection.
 *
 * This module also exports a `createUdpAnnouncer` helper so that each node can
 * respond to broadcast DISCOVER messages while it is running.
 *
 * Exports:
 *   discoverNodes(clusterPort, timeoutMs) → Promise<Array<{host, clusterPort}>>
 *   createUdpAnnouncer(clusterPort)       → dgram.Socket  (call .close() to stop)
 *   getLocalIPv4Addresses()               → Array<{address, netmask}>
 */

import dgram from "dgram";
import net from "net";
import os from "os";

const DISCOVER_MAGIC = "PATCHGUARD_DISCOVER";
const ANNOUNCE_MAGIC = "PATCHGUARD_ANNOUNCE";

// ── Network helpers ───────────────────────────────────────────────────────────

/**
 * Returns all non-loopback IPv4 interface descriptors for this machine.
 * @returns {Array<{address: string, netmask: string}>}
 */
export function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const result = [];
  for (const ifaces of Object.values(interfaces)) {
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) {
        result.push({ address: iface.address, netmask: iface.netmask });
      }
    }
  }
  return result;
}

/**
 * Computes the broadcast address for a given unicast IP and netmask.
 * @param {string} ip
 * @param {string} netmask
 * @returns {string}
 */
function getBroadcastAddress(ip, netmask) {
  const ipParts = ip.split(".").map(Number);
  const maskParts = netmask.split(".").map(Number);
  return ipParts
    .map((part, i) => (part | (~maskParts[i] & 0xff)) >>> 0)
    .join(".");
}

/**
 * Returns all 254 host addresses for the /24 subnet that contains `ip`.
 * @param {string} ip
 * @returns {string[]}
 */
function getSubnetHosts(ip) {
  const base = ip.split(".").slice(0, 3).join(".");
  return Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
}

// ── TCP probe ─────────────────────────────────────────────────────────────────

/**
 * Attempts a TCP connection to host:port within timeoutMs.
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => finish(true));
    socket.on("error", () => finish(false));
    socket.on("timeout", () => finish(false));
  });
}

// ── UDP broadcast discovery ───────────────────────────────────────────────────

/**
 * Sends a UDP DISCOVER broadcast on every local subnet and collects ANNOUNCE
 * responses for up to `timeoutMs` milliseconds.
 * @param {number} clusterPort
 * @param {number} timeoutMs
 * @returns {Promise<string[]>} list of responding host IPs
 */
async function udpBroadcastDiscover(clusterPort, timeoutMs) {
  return new Promise((resolve) => {
    const found = new Set();
    const socket = dgram.createSocket("udp4");
    let closed = false;
    const done = () => {
      if (!closed) {
        closed = true;
        try {
          socket.close();
        } catch {
          // already closed
        }
        resolve([...found]);
      }
    };
    const timer = setTimeout(done, timeoutMs);

    socket.on("message", (msg, rinfo) => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.type === ANNOUNCE_MAGIC) {
          found.add(rinfo.address);
        }
      } catch {
        // ignore non-JSON datagrams
      }
    });

    socket.on("error", () => {
      clearTimeout(timer);
      done();
    });

    socket.bind(0, () => {
      socket.setBroadcast(true);
      const payload = Buffer.from(
        JSON.stringify({ type: DISCOVER_MAGIC, port: clusterPort })
      );
      for (const { address, netmask } of getLocalIPv4Addresses()) {
        const bcast = getBroadcastAddress(address, netmask);
        socket.send(payload, clusterPort, bcast, (err) => {
          if (err) {
            console.warn(
              `[discovery] UDP send to ${bcast} failed:`,
              err.message
            );
          }
        });
      }
    });
  });
}

// ── TCP subnet scan ───────────────────────────────────────────────────────────

/**
 * Scans every host on every local /24 subnet for an open `port`.
 * Runs probes in batches of `concurrency` to bound parallelism.
 *
 * Performance note: with the default 500 ms probe timeout and concurrency=50,
 * a single /24 subnet (254 hosts) requires ceil(254/50) = 6 sequential rounds
 * each up to 500 ms, so the worst-case scan time per subnet is ~3 s.  For each
 * additional local subnet the time adds linearly.  Most deployments have a
 * single local subnet, so the total fallback scan completes in under 5 s.
 * The UDP broadcast path (tried first) typically completes in under 2 s.
 *
 * @param {number} port
 * @param {number} probeTimeoutMs  Per-host TCP connection timeout.
 * @param {number} [concurrency=50]  Max simultaneous probes.
 * @returns {Promise<string[]>}
 */
async function tcpScanSubnet(port, probeTimeoutMs, concurrency = 50) {
  const localAddrs = new Set(getLocalIPv4Addresses().map((a) => a.address));
  const allHosts = [];
  for (const addr of localAddrs) {
    for (const host of getSubnetHosts(addr)) {
      if (!localAddrs.has(host)) {
        allHosts.push(host);
      }
    }
  }

  const found = [];
  for (let i = 0; i < allHosts.length; i += concurrency) {
    const batch = allHosts.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((host) =>
        tcpProbe(host, port, probeTimeoutMs).then((ok) => ({ host, ok }))
      )
    );
    for (const { host, ok } of results) {
      if (ok) {
        found.push(host);
      }
    }
  }
  return found;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Discovers peer nodes on the local network.
 *
 * Strategy:
 *   1. UDP broadcast (fast – up to 2 s).
 *   2. TCP subnet scan (fallback – only if UDP found nothing).
 *
 * @param {number} clusterPort
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<Array<{host: string, clusterPort: number}>>}
 */
export async function discoverNodes(clusterPort, timeoutMs = 3000) {
  const localAddrs = new Set(getLocalIPv4Addresses().map((a) => a.address));

  // Fast path: UDP broadcast
  const udpHosts = await udpBroadcastDiscover(
    clusterPort,
    Math.min(timeoutMs, 2000)
  );
  const uniqueHosts = new Set(udpHosts.filter((h) => !localAddrs.has(h)));

  // Fallback: TCP port scan
  if (uniqueHosts.size === 0) {
    const tcpHosts = await tcpScanSubnet(clusterPort, 500, 50);
    for (const h of tcpHosts) {
      if (!localAddrs.has(h)) {
        uniqueHosts.add(h);
      }
    }
  }

  return [...uniqueHosts].map((host) => ({ host, clusterPort }));
}

/**
 * Creates and returns a UDP socket that listens on `clusterPort` and
 * automatically replies to DISCOVER messages with an ANNOUNCE response.
 * Callers should hold the returned socket reference and call `.close()` on
 * shutdown.
 *
 * @param {number} clusterPort
 * @returns {dgram.Socket}
 */
export function createUdpAnnouncer(clusterPort) {
  const socket = dgram.createSocket("udp4");

  socket.on("message", (msg, rinfo) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === DISCOVER_MAGIC) {
        const reply = Buffer.from(JSON.stringify({ type: ANNOUNCE_MAGIC }));
        socket.send(reply, rinfo.port, rinfo.address, (err) => {
          if (err) {
            console.warn(
              `[discovery] UDP announce to ${rinfo.address} failed:`,
              err.message
            );
          }
        });
      }
    } catch {
      // ignore non-JSON datagrams
    }
  });

  socket.on("error", (err) => {
    console.error("[discovery] UDP announcer error:", err.message);
  });

  socket.bind(clusterPort, () => {
    socket.setBroadcast(true);
    console.log(`[discovery] UDP announcer listening on port ${clusterPort}`);
  });

  return socket;
}

/**
 * Server Agent – application entry point.
 *
 * What this file does:
 * - Loads environment variables from `.env` via dotenv.
 * - Creates an Express application and attaches JSON body parsing middleware.
 * - Mounts the GitHub webhook handler at POST /github/webhook using
 *   `@octokit/webhooks` node middleware for signature-verified event dispatch.
 * - Initialises the distributed cluster layer (WebSocket server, node
 *   discovery, coordinator) and attaches it to the shared HTTP server.
 * - Exposes two cluster management REST endpoints:
 *     GET /cluster/status     – returns registered nodes and their layer ranges.
 *     GET /cluster/rpc-config – returns the OLLAMA_RPC_SERVERS value the
 *                               coordinator Ollama should be started with.
 * - Starts the HTTP server on port 3000.
 *
 * Environment variables consumed (via downstream modules):
 * - GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY
 * - GITHUB_WEBHOOK_SECRET
 * - CLUSTER_PORT, NODE_GPU_MEMORY_GB, NODE_OLLAMA_PORT, COORDINATOR_HOST
 * - OLLAMA_MANAGE, OLLAMA_BIN, NODE_OLLAMA_RPC_PORT
 *
 * Important behavior notes:
 * - Uses top-level await (Node ESM `"type": "module"`); Node ≥ 16 required.
 * - The HTTP server is created before `initCluster` so the WebSocket server
 *   can be attached to the same port as the REST API.
 */

await import("dotenv/config");

const { default: express } = await import("express");
const { default: http } = await import("http");
const { createNodeMiddleware } = await import("@octokit/webhooks");
const { webhooks } = await import("./github/webhooks/receiver.js");
const { initCluster, getCoordinator, getOllamaManager } = await import(
  "./cluster/index.js"
);

const app = express();

// Middleware to parse JSON bodies (if needed for other routes)
app.use(express.json());
// Webhook handler route
app.use(createNodeMiddleware(webhooks, { path: "/github/webhook" }));

// Create the HTTP server so we can attach the cluster WebSocket server to it
const server = http.createServer(app);

// Cluster status endpoint – returns registered nodes and their layer assignments
app.get("/cluster/status", (_req, res) => {
  const coordinator = getCoordinator();
  res.json({ nodes: coordinator ? coordinator.getState() : [] });
});

// Returns the current OLLAMA_RPC_SERVERS value that the coordinator's Ollama
// should be started with to distribute large model inference across the cluster.
// Use this to verify or manually configure Ollama when OLLAMA_MANAGE=false.
app.get("/cluster/rpc-config", (_req, res) => {
  const coordinator = getCoordinator();
  const ollamaManager = getOllamaManager();
  const rpcServers = coordinator ? coordinator.getRpcServers() : [];
  res.json({
    rpcServers,
    ollamaRpcServers: rpcServers.join(",") || null,
    managed: ollamaManager !== null && ollamaManager.isRunning(),
  });
});

// Initialise the distributed cluster (node discovery + WebSocket server)
await initCluster(server);

server.listen(3000, () => {
  console.log("Server Agent is running on port 3000");
});

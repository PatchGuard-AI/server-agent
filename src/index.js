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

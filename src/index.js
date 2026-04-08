await import("dotenv/config");

const { default: express } = await import("express");
const { default: http } = await import("http");
const { createNodeMiddleware } = await import("@octokit/webhooks");
const { webhooks } = await import("./github/webhooks/receiver.js");
const { initCluster, getCoordinator } = await import("./cluster/index.js");

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

// Initialise the distributed cluster (node discovery + WebSocket server)
await initCluster(server);

server.listen(3000, () => {
  console.log("Server Agent is running on port 3000");
});

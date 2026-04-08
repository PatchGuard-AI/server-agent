await import("dotenv/config");

const { default: express } = await import("express");
const { createNodeMiddleware } = await import("@octokit/webhooks");
const { webhooks } = await import("./github/webhooks/receiver.js");

const app = express();

// Middleware to parse JSON bodies (if needed for other routes)
app.use(express.json());
// Webhook handler route
app.use(createNodeMiddleware(webhooks, { path: "/github/webhook" }));

app.listen(3000, () => {
  console.log("Server Agent is running on port 3000");
});

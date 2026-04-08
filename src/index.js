await import("dotenv/config");

const { default: express } = await import("express");
const { webhooks } = await import("./github/webhooks/reciever.js");

const app = express();

// Middleware to parse JSON bodies (if needed for other routes)
app.use(express.json());
// Webhook handler route
app.use("/github/webhook", webhooks.middleware);

app.listen(3000, () => {
  console.log("Server Agent is running on port 3000");
});

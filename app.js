const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");

dotenv.config();
const app = express();
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("Connected to MongoDB"))
    .catch(err => console.error("MongoDB connection error:", err));

// MongoDB Schemas
const ServerSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    url: { type: String, required: true },
    status: { type: String, default: "Unknown" },
});

const LogSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    statuses: { type: Object, required: true },
});

const DeploymentSchema = new mongoose.Schema({
    version: { type: String, required: true },
    status: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
});

const Server = mongoose.model("Server", ServerSchema);
const Log = mongoose.model("Log", LogSchema);
const Deployment = mongoose.model("Deployment", DeploymentSchema);

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
});
app.use(limiter);

let PIPELINE_STATUS = "success";

const SERVER_HEALTH_LOGS = [];

// Authentication Middleware
const authenticate = (req, res, next) => {
    const apiKey = req.headers["x-api-key"];
    if (apiKey === process.env.API_KEY) {
        next();
    } else {
        res.status(403).json({ message: "Forbidden: Invalid API Key" });
    }
};

// Update checkServerHealth to ensure server health is fetched and stored correctly
const checkServerHealth = async () => {
    let statuses = {};
    try {
        const servers = await Server.find(); // Fetch servers from MongoDB
        for (let server of servers) {
            try {
                const response = await axios.get(server.url, { timeout: 3000 });
                statuses[server.name] = { status: "Up", reason: null };
            } catch (error) {
                statuses[server.name] = {
                    status: "Down",
                    reason: error.response?.statusText || error.message || "Unknown Error",
                };
            }
            server.status = statuses[server.name].status;
            await server.save(); // Update server status in MongoDB
        }
        const log = new Log({ timestamp: new Date(), statuses });
        await log.save(); // Save the health check log
    } catch (error) {
        console.error("Error checking server health:", error.message);
    }
    return statuses;
};

app.get("/status", async (req, res) => {
    try {
        const serverHealth = await checkServerHealth();
        res.json({ "CI/CD Status": PIPELINE_STATUS, "Server Health": serverHealth });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

// Update /deploy to track version control
app.post("/deploy", authenticate, async (req, res) => {
    const { version } = req.body;
    if (!version) {
        return res.status(400).json({ message: "Version is required" });
    }
    PIPELINE_STATUS = "in_progress";
    const deployment = new Deployment({ version, status: "in_progress", timestamp: new Date() });
    await deployment.save();

    // Simulate deployment logic
    setTimeout(async () => {
        PIPELINE_STATUS = "success";
        deployment.status = "success";
        await deployment.save();
    }, 2000);

    res.json({ message: "Deployment triggered", status: PIPELINE_STATUS, version });
});

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

const sendSlackNotification = async (message) => {
    if (!SLACK_WEBHOOK_URL) {
        console.error("Slack Webhook URL is not configured.");
        return;
    }
    try {
        await axios.post(SLACK_WEBHOOK_URL, { text: message });
    } catch (error) {
        console.error("Failed to send Slack notification:", error.message);
    }
};

app.post("/notify", authenticate, async (req, res) => {
    const serverHealth = await checkServerHealth();
    const message = `CI/CD Status: ${PIPELINE_STATUS}\nServer Health: ${JSON.stringify(serverHealth)}`;
    await sendSlackNotification(message);
    res.json({ "message": "Notification sent" });
});

// Update /servers to use MongoDB
app.post("/servers", authenticate, async (req, res) => {
    const { name, url } = req.body;
    if (!name || !url) {
        return res.status(400).json({ message: "Name and URL are required" });
    }
    try {
        const server = new Server({ name, url });
        await server.save();
        res.status(201).json({ message: "Server added", server });
    } catch (error) {
        if (error.code === 11000) {
            res.status(409).json({ message: "Server with this name already exists" });
        } else {
            res.status(500).json({ message: "Internal Server Error", error: error.message });
        }
    }
});

app.delete("/servers/:name", authenticate, async (req, res) => {
    const { name } = req.params;
    try {
        const server = await Server.findOneAndDelete({ name });
        if (server) {
            res.json({ message: "Server removed", server });
        } else {
            res.status(404).json({ message: "Server not found" });
        }
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

// Update /logs to fetch from MongoDB
app.get("/logs", authenticate, async (req, res) => {
    try {
        const logs = await Log.find();
        res.json(logs);
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

// Add endpoint to view deployment history
app.get("/deployments", authenticate, async (req, res) => {
    try {
        const deployments = await Deployment.find();
        res.json(deployments);
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

// Update /dashboard endpoint to ensure server health is displayed correctly
app.get("/dashboard", async (req, res) => {
    const { url } = req.query; // Accept URL as input via query parameter
    let urlStatus = "Unknown";

    if (url) {
        try {
            const response = await axios.get(url, { timeout: 3000 });
            urlStatus = response.status === 200 ? "Up" : "Down";
        } catch (error) {
            urlStatus = "Down";
        }
    }

    try {
        const serverHealth = await checkServerHealth(); // Fetch server health
        const logs = await Log.find();
        const deployments = await Deployment.find(); // Ensure deployments are fetched

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Dashboard</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 20px; }
                    h1, h2 { color: #333; }
                    table { border-collapse: collapse; width: 100%; margin-top: 20px; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                    th { background-color: #f4f4f4; }
                    form { margin-bottom: 20px; }
                    input[type="text"] { padding: 8px; width: 300px; }
                    button { padding: 8px 12px; }
                </style>
            </head>
            <body>
                <h1>Dashboard</h1>
                <form method="get" action="/dashboard">
                    <label for="url">Check URL Status:</label>
                    <input type="text" id="url" name="url" placeholder="Enter URL" required>
                    <button type="submit">Check</button>
                </form>
                <p><strong>URL:</strong> ${url || "N/A"}</p>
                <p><strong>Status:</strong> ${urlStatus}</p>
                <p><strong>CI/CD Status:</strong> ${PIPELINE_STATUS}</p>
                <h2>Server Health</h2>
                <table>
                    <tr>
                        <th>Server</th>
                        <th>Status</th>
                        <th>Reason</th>
                    </tr>
                    ${Object.entries(serverHealth)
                        .map(
                            ([server, { status, reason }]) =>
                                `<tr><td>${server}</td><td>${status}</td><td>${reason || "N/A"}</td></tr>`
                        )
                        .join("")}
                </table>
                <h2>Logs</h2>
                <table>
                    <tr>
                        <th>Timestamp</th>
                        <th>Statuses</th>
                    </tr>
                    ${logs
                        .map(
                            (log) =>
                                `<tr><td>${log.timestamp}</td><td>${JSON.stringify(
                                    log.statuses
                                )}</td></tr>`
                        )
                        .join("")}
                </table>
                <h2>Deployment History</h2>
                <table>
                    <tr>
                        <th>Version</th>
                        <th>Status</th>
                        <th>Timestamp</th>
                    </tr>
                    ${deployments
                        .map(
                            (deployment) =>
                                `<tr><td>${deployment.version}</td><td>${deployment.status}</td><td>${new Date(
                                    deployment.timestamp
                                ).toLocaleString()}</td></tr>`
                        )
                        .join("")}
                </table>
            </body>
            </html>
        `;
        res.send(html);
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`https://localhost:${PORT}`);
});

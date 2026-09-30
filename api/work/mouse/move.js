const admin = require("firebase-admin");

function initFirebase() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
  }
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "https://coolerstarfish0.github.io");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

module.exports = async (req, res) => {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    initFirebase();

    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing authentication token" });
    }

    const token = authHeader.slice(7);
    await admin.auth().verifyIdToken(token);

    const { x, y } = req.body || {};

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({
        error: "x and y must be valid numbers",
      });
    }

    const localAIUrl = process.env.LOCAL_AI_URL;
    const localAISecret = process.env.LOCAL_AI_SECRET;

    if (!localAIUrl || !localAISecret) {
      return res.status(500).json({
        error: "Local AI configuration is missing",
      });
    }

    const response = await fetch(`${localAIUrl}/api/work/mouse/move`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${localAISecret}`,
      },
      body: JSON.stringify({ x, y }),
    });

    const data = await response.json();

    return res.status(response.status).json(data);

  } catch (error) {
    console.error("Mouse move error:", error);

    return res.status(500).json({
      error: "Failed to move mouse",
    });
  }
};

import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const ORIGIN = "https://coolerstarfish0.github.io";

function setCors(res, method) {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", `${method}, OPTIONS`);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function firebaseAuth() {
  if (getApps().length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is missing");
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  return getAuth();
}

export function createWorkProxy({ method = "POST", path, validate = () => null }) {
  return async function handler(req, res) {
    setCors(res, method);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== method) return res.status(405).json({ error: "Method not allowed" });

    try {
      const authorization = req.headers.authorization || "";
      if (!authorization.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const firebaseToken = authorization.slice(7).trim();
      if (!firebaseToken) return res.status(401).json({ error: "Invalid authentication token" });

      try {
        await firebaseAuth().verifyIdToken(firebaseToken);
      } catch (error) {
        console.error("Firebase token verification failed:", error);
        return res.status(401).json({ error: "Invalid or expired login session" });
      }

      const localAIUrl = process.env.LOCAL_AI_URL;
      const localAISecret = process.env.LOCAL_AI_SECRET;
      if (!localAIUrl || !localAISecret) {
        return res.status(500).json({ error: "Local AI environment variables are missing" });
      }

      const body = req.body && typeof req.body === "object" ? req.body : {};
      const validationError = validate(body);
      if (validationError) return res.status(400).json({ error: validationError });

      const response = await fetch(`${localAIUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          "Authorization": `Bearer ${localAISecret}`,
          "X-Firebase-Token": firebaseToken,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {})
        },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {})
      });

      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw || "Invalid response from local AI bridge" }; }
      return res.status(response.status).json(data);
    } catch (error) {
      console.error("Work Mode proxy error:", error);
      return res.status(502).json({ error: "Failed to connect to Work Mode", details: error.message });
    }
  };
}

const ALLOWED_ORIGIN = "https://coolerstarfish0.github.io";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const action = String(req.query?.action || "").toLowerCase();
  const supported = new Set(["click", "move", "scroll", "double-click"]);
  if (!supported.has(action)) return res.status(404).json({ error: "Unknown mouse action" });

  try {
    const { enforceWorkRank } = await import("../../../lib/work-access.js");
    if (!await enforceWorkRank(req, res)) return;

    const firebaseToken = String(req.headers.authorization || "").slice(7).trim();
    if (!firebaseToken) return res.status(401).json({ error: "Authentication token required" });

    const localAIUrl = process.env.LOCAL_AI_URL;
    const localAISecret = process.env.LOCAL_AI_SECRET;
    if (!localAIUrl || !localAISecret) {
      return res.status(500).json({ error: "Local AI configuration is missing" });
    }

    const body = req.body || {};
    let payload;
    if (action === "click") {
      const button = body.button === undefined ? "left" : body.button;
      if (!["left", "right", "middle"].includes(button)) return res.status(400).json({ error: "button must be left, right, or middle" });
      payload = { button };
    } else if (action === "move") {
      const { x, y } = body;
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
        return res.status(400).json({ error: "Invalid mouse coordinates" });
      }
      payload = { x, y };
    } else if (action === "scroll") {
      if (typeof body.amount !== "number" || !Number.isFinite(body.amount)) return res.status(400).json({ error: "amount must be a valid number" });
      payload = { amount: body.amount };
    } else {
      payload = {};
    }

    const response = await fetch(localAIUrl.replace(/\/$/, "") + "/api/work/mouse/" + action, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + localAISecret,
        "X-Firebase-Token": firebaseToken
      },
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
    let data;
    try { data = JSON.parse(responseText); }
    catch { data = { raw: responseText }; }
    if (!response.ok) return res.status(response.status).json({ error: data.error || "Local mouse action failed." });
    return res.status(200).json(data);
  } catch (error) {
    console.error("Mouse action error:", error);
    return res.status(500).json({ error: error.message || "Failed to perform mouse action." });
  }
}

const ALLOWED_ORIGIN = "https://coolerstarfish0.github.io";

function cors(res) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Vary", "Origin");
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    try {
        const { enforceWorkRank } = await import("../../../lib/work-access.js");
        if (!await enforceWorkRank(req, res)) return;

        const { localAIUrl, localAISecret } = await (await import("../../../lib/local-ai-config.js")).getLocalAIConfig();
        if (!localAIUrl || !localAISecret) {
            return res.status(500).json({ error: "Local AI configuration is missing" });
        }

        const { key, modifiers } = req.body || {};
        if (typeof key !== "string" || key.length === 0 || key.length > 50) {
            return res.status(400).json({ error: "key must be a valid string" });
        }
        if (modifiers !== undefined && !Array.isArray(modifiers)) {
            return res.status(400).json({ error: "modifiers must be an array" });
        }

        const allowedModifiers = ["shift", "control", "alt", "command"];
        const safeModifiers = modifiers || [];
        if (!safeModifiers.every(modifier => allowedModifiers.includes(modifier))) {
            return res.status(400).json({ error: "Invalid modifier" });
        }

        const response = await fetch(localAIUrl + "/api/work/keyboard/key", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + localAISecret
            },
            body: JSON.stringify({ key, modifiers: safeModifiers })
        });

        const data = await response.json().catch(() => ({ error: "Local bridge returned an invalid response." }));
        return res.status(response.status).json(data);
    } catch (error) {
        console.error("Keyboard key error:", error);
        return res.status(500).json({ error: "Failed to press key" });
    }
}

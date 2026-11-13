import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getLocalAIConfig } from "../../../lib/local-ai-config.js";

function initFirebase() {
    if (!getApps().length) {
        const projectId = process.env.FIREBASE_PROJECT_ID;
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
        const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
        if (!projectId || !clientEmail || !privateKey) {
            throw new Error("Firebase Admin credentials are not configured.");
        }
        initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    }
}

function cors(res) {
    res.setHeader("Access-Control-Allow-Origin", "https://coolerstarfish0.github.io");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const action = String(req.query?.action || "");
    if (action !== "key" && action !== "type") {
        return res.status(404).json({ error: "Unknown keyboard action" });
    }

    try {
        const { enforceWorkRank } = await import("../../../lib/work-access.js");
        if (!await enforceWorkRank(req, res)) return;

        const authHeader = req.headers.authorization || "";
        if (!authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: action === "key" ? "Missing authentication token" : "Missing authentication." });
        }
        const firebaseToken = authHeader.slice(7);
        if (!firebaseToken) {
            return res.status(401).json({ error: "Missing authentication token." });
        }

        if (action === "key") {
            initFirebase();
            await getAuth().verifyIdToken(firebaseToken);

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

            const { localAIUrl, localAISecret } = await getLocalAIConfig();
            const response = await fetch(`${localAIUrl}/api/work/keyboard/key`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${localAISecret}`
                },
                body: JSON.stringify({ key, modifiers: safeModifiers })
            });
            const data = await response.json();
            return res.status(response.status).json(data);
        }

        const { text } = req.body || {};
        if (typeof text !== "string" || text.length > 5000) {
            return res.status(400).json({
                error: "Invalid text. Text must be a string of 5000 characters or fewer."
            });
        }

        const { localAIUrl, localAISecret } = await getLocalAIConfig();
        const response = await fetch(`${localAIUrl}/api/work/keyboard/type`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${localAISecret}`,
                "X-Firebase-Token": firebaseToken
            },
            body: JSON.stringify({ text })
        });
        const responseText = await response.text();
        let data;
        try {
            data = JSON.parse(responseText);
        } catch {
            data = { raw: responseText };
        }
        if (!response.ok) {
            return res.status(response.status).json({
                error: data.error || "Local keyboard request failed."
            });
        }
        return res.status(200).json(data);
    } catch (error) {
        console.error(`Keyboard ${action} error:`, error);
        return res.status(500).json({
            error: error.message || (action === "key" ? "Failed to press key" : "Keyboard typing function failed.")
        });
    }
}

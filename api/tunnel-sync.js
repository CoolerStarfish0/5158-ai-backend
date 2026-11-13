import crypto from "node:crypto";

const ALLOWED_ORIGIN = "https://coolerstarfish0.github.io";

function validTunnelUrl(value) {
    if (typeof value !== "string" || value.length > 300) return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password ||
        url.port || url.pathname !== "/" || url.search || url.hash ||
        !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(url.hostname)) return null;
    return url.origin;
}

function sameSecret(a, b) {
    if (!a || !b) return false;
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export default async function handler(req, res) {
    const origin = req.headers.origin;
    if (origin && origin !== ALLOWED_ORIGIN) return res.status(403).json({ error: "Origin not allowed." });
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
        res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

    try {
        const expected = process.env.TUNNEL_SYNC_SECRET;
        const authorization = String(req.headers.authorization || "");
        const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
        if (!expected || !sameSecret(supplied, expected)) {
            return res.status(401).json({ error: "Tunnel registration is not authorized." });
        }

        const url = validTunnelUrl(req.body?.url);
        if (!url) return res.status(400).json({ error: "Provide a valid HTTPS trycloudflare.com tunnel URL." });

        const { getApps, initializeApp, cert } = await import("firebase-admin/app");
        const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
        let app = getApps().find(item => item.name === "[DEFAULT]");
        if (!app) {
            const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
            if (!raw) return res.status(500).json({ error: "Firebase Admin credentials are not configured." });
            app = initializeApp({ credential: cert(JSON.parse(raw)) });
        }

        await getFirestore(app).collection("privateConfig").doc("localAI").set({
            url,
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: "tunnel-sync"
        }, { merge: true });

        return res.status(200).json({ success: true, registered: true });
    } catch (error) {
        console.error("Tunnel URL registration failed:", error);
        return res.status(500).json({ error: "Could not save the Cloudflare Tunnel URL." });
    }
}

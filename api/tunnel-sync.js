const ALLOWED_ORIGIN = "https://coolerstarfish0.github.io";

function sendError(res, status, error) {
    return res.status(status).json({ error });
}

function validTunnelUrl(value) {
    if (typeof value !== "string" || value.length > 300) return null;

    try {
        const url = new URL(value.trim());
        if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.port ||
            url.search ||
            url.hash ||
            (url.pathname !== "/" && url.pathname !== "") ||
            !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(url.hostname)
        ) return null;

        return "https://" + url.hostname.toLowerCase();
    } catch {
        return null;
    }
}

async function getOwnerServices(req) {
    const authorization = String(req.headers.authorization || "");
    if (!authorization.startsWith("Bearer ")) {
        throw Object.assign(new Error("Authentication required."), { status: 401 });
    }

    const { getApps, initializeApp, cert } = await import("firebase-admin/app");
    const { getAuth } = await import("firebase-admin/auth");
    const { getFirestore, FieldValue } = await import("firebase-admin/firestore");

    let app = getApps().find(item => item.name === "[DEFAULT]");
    if (!app) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (!raw) throw Object.assign(new Error("Firebase Admin credentials are not configured."), { status: 503 });
        app = initializeApp({ credential: cert(JSON.parse(raw)) });
    }

    let decoded;
    try {
        decoded = await getAuth(app).verifyIdToken(authorization.slice(7).trim());
    } catch {
        throw Object.assign(new Error("Your login session is invalid or expired. Sign in again."), { status: 401 });
    }

    if (
        !process.env.OWNER_UID ||
        decoded.uid !== process.env.OWNER_UID ||
        decoded.firebase?.sign_in_provider === "anonymous"
    ) {
        throw Object.assign(new Error("Owner access required."), { status: 403 });
    }

    return { db: getFirestore(app), FieldValue, uid: decoded.uid };
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") return res.status(204).end();

    const origin = req.headers.origin;
    if (origin && origin !== ALLOWED_ORIGIN) return sendError(res, 403, "Origin not allowed.");
    if (!["GET", "POST"].includes(req.method)) return sendError(res, 405, "Method not allowed.");

    try {
        const { db, FieldValue, uid } = await getOwnerServices(req);
        const ref = db.collection("privateConfig").doc("localAI");

        if (req.method === "GET") {
            const snapshot = await ref.get();
            const savedUrl = snapshot.exists ? String(snapshot.data()?.url || "") : "";
            const url = validTunnelUrl(savedUrl) || validTunnelUrl(process.env.LOCAL_AI_URL || "");
            return res.status(200).json({
                configured: Boolean(url),
                url: url || null,
                source: savedUrl ? "firestore" : (url ? "environment" : "none")
            });
        }

        const url = validTunnelUrl(req.body?.url);
        if (!url) {
            return sendError(res, 400, "Enter a valid HTTPS Cloudflare Quick Tunnel URL ending in .trycloudflare.com.");
        }

        await ref.set({
            url,
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: uid
        }, { merge: true });

        return res.status(200).json({ success: true, url });
    } catch (error) {
        console.error("Tunnel sync error:", error);
        return sendError(res, error.status || 500, error.message || "Tunnel configuration failed.");
    }
}

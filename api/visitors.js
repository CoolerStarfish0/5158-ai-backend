export default async function handler(req, res) {
    const allowedOrigin = "https://coolerstarfish0.github.io";
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store, max-age=0");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (!["GET", "POST"].includes(req.method)) {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const authorization = req.headers.authorization || "";
        if (!authorization.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Authentication required" });
        }
        const idToken = authorization.slice(7).trim();
        if (!idToken) return res.status(401).json({ error: "Invalid authentication token" });

        const { getApps, initializeApp, cert } = await import("firebase-admin/app");
        const { getAuth } = await import("firebase-admin/auth");
        const { getFirestore, FieldValue } = await import("firebase-admin/firestore");

        if (getApps().length === 0) {
            if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
                return res.status(500).json({ error: "FIREBASE_SERVICE_ACCOUNT is missing" });
            }
            initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
        }

        const firebaseAuth = getAuth();
        const db = getFirestore();
        let decodedToken;
        try {
            decodedToken = await firebaseAuth.verifyIdToken(idToken);
        } catch {
            return res.status(401).json({ error: "Invalid or expired login session" });
        }

        const uid = decodedToken.uid;
        const ownerUid = process.env.OWNER_UID;
        const isOwner = Boolean(ownerUid && uid === ownerUid);

        if (req.method === "GET") {
            if (!isOwner || decodedToken.firebase?.sign_in_provider === "anonymous") {
                return res.status(403).json({ error: "Owner access required" });
            }
            const snapshot = await db.collection("visitorLogs")
                .orderBy("lastSeen", "desc")
                .limit(200)
                .get();
            const visitors = snapshot.docs.map(document => {
                const data = document.data();
                const toIso = value => value?.toDate?.()?.toISOString?.() || null;
                return {
                    id: document.id,
                    displayName: data.displayName || null,
                    email: data.email || null,
                    ip: data.ip || null,
                    accountType: data.accountType || "unknown",
                    page: data.page || "/",
                    visitCount: Number(data.visitCount) || 1,
                    firstSeen: toIso(data.firstSeen),
                    lastSeen: toIso(data.lastSeen)
                };
            });
            return res.status(200).json({ visitors });
        }

        const body = req.body || {};
        const visitorId = typeof body.visitorId === "string" ? body.visitorId : "";
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        const page = typeof body.page === "string" ? body.page.slice(0, 300) : "/";

        if (!/^[A-Za-z0-9_-]{8,120}$/.test(visitorId) ||
            !/^[A-Za-z0-9_-]{8,120}$/.test(sessionId)) {
            return res.status(400).json({ error: "Invalid visitor or session ID" });
        }

        const account = await firebaseAuth.getUser(uid);
        const isGuest = decodedToken.firebase?.sign_in_provider === "anonymous";
        const forwardedFor = req.headers["x-forwarded-for"];
        const forwardedIp = Array.isArray(forwardedFor)
            ? forwardedFor[0]
            : typeof forwardedFor === "string"
                ? forwardedFor.split(",")[0].trim()
                : "";
        const ip = (req.headers["x-real-ip"] || forwardedIp || "").toString().slice(0, 100) || null;

        const ref = db.collection("visitorLogs").doc(visitorId);
        const previous = await ref.get();
        const previousData = previous.exists ? previous.data() : {};
        const isNewSession = !previous.exists || previousData.lastSessionId !== sessionId;
        const now = FieldValue.serverTimestamp();
        const update = {
            visitorId,
            uid,
            accountType: isGuest ? "guest" : "google",
            email: isGuest ? null : (account.email || null),
            displayName: isGuest ? null : (account.displayName || null),
            ip,
            page,
            lastSessionId: sessionId,
            lastSeen: now,
            visitCount: previous.exists
                ? (Number(previousData.visitCount) || 1) + (isNewSession ? 1 : 0)
                : 1
        };
        if (!previous.exists) update.firstSeen = now;
        await ref.set(update, { merge: true });
        return res.status(200).json({ ok: true });
    } catch (error) {
        console.error("Visitor analytics error:", error);
        return res.status(500).json({ error: "Visitor analytics request failed" });
    }
}

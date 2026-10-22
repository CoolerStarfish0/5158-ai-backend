const ALLOWED_FEATURES = new Set(["chat", "games", "market-day", "calendar", "work-mode", "shared-chats"]);
const FEATURE_LABELS = Object.freeze({
    chat: "Axon Chat",
    games: "Games Hub",
    "market-day": "Market Day",
    calendar: "Calendar",
    "work-mode": "Work Mode",
    "shared-chats": "Shared Chats"
});

export default async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    if (![ "GET", "POST" ].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });

    const { getApps, initializeApp, cert } = await import("firebase-admin/app");
    const { getAuth } = await import("firebase-admin/auth");
    const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
    if (getApps().length === 0) {
        if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(500).json({ error: "FIREBASE_SERVICE_ACCOUNT is missing" });
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    const db = getFirestore();

    if (req.method === "POST") {
        const feature = String(req.body?.feature || "");
        if (!ALLOWED_FEATURES.has(feature)) return res.status(400).json({ error: "Unknown feature" });
        const day = new Date().toISOString().slice(0, 10);
        const ref = db.collection("featureAnalyticsDaily").doc(day);
        await ref.set({
            day,
            updatedAt: FieldValue.serverTimestamp(),
            counts: { [feature]: FieldValue.increment(1) }
        }, { merge: true });
        return res.status(202).json({ ok: true });
    }

    const authorization = req.headers.authorization || "";
    if (!authorization.startsWith("Bearer ")) return res.status(401).json({ error: "Authentication required" });
    let decodedToken;
    try { decodedToken = await getAuth().verifyIdToken(authorization.slice(7).trim()); }
    catch { return res.status(401).json({ error: "Invalid or expired login session" }); }
    const ownerUid = process.env.OWNER_UID;
    if (!ownerUid || decodedToken.uid !== ownerUid || decodedToken.firebase?.sign_in_provider === "anonymous") {
        return res.status(403).json({ error: "Owner access required" });
    }

    const snapshot = await db.collection("featureAnalyticsDaily").orderBy("day", "desc").limit(30).get();
    const days = snapshot.docs.map(document => {
        const data = document.data();
        const counts = {};
        for (const feature of ALLOWED_FEATURES) counts[feature] = Math.max(0, Number(data.counts?.[feature]) || 0);
        return { day: data.day || document.id, counts };
    });
    const totals = {};
    for (const feature of ALLOWED_FEATURES) {
        totals[feature] = days.reduce((sum, day) => sum + day.counts[feature], 0);
    }
    return res.status(200).json({
        labels: Object.fromEntries(Object.entries(FEATURE_LABELS)),
        totals,
        days: days.reverse()
    });
}

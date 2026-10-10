const ALLOWED_ORIGIN = "https://coolerstarfish0.github.io";
const VALID_RANKS = new Set(["WARDEN", "PIONEER", "RESIDENT", "VISITOR"]);

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (!["GET", "POST"].includes(req.method)) {
        return res.status(405).json({ error: "Method not allowed" });
    }
    if (req.headers.origin && req.headers.origin !== ALLOWED_ORIGIN) {
        return res.status(403).json({ error: "Origin not allowed" });
    }

    try {
        const { getApps, initializeApp, cert } = await import("firebase-admin/app");
        const { getAuth } = await import("firebase-admin/auth");
        const { getFirestore, FieldValue } = await import("firebase-admin/firestore");

        if (getApps().length === 0) {
            if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
                return res.status(500).json({ error: "FIREBASE_SERVICE_ACCOUNT is missing" });
            }
            initializeApp({
                credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
        }

        const ownerUid = process.env.OWNER_UID;
        if (!ownerUid) {
            return res.status(500).json({ error: "OWNER_UID is missing in Vercel environment variables" });
        }

        const authorization = req.headers.authorization || "";
        if (!authorization.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Authentication required" });
        }

        let decoded;
        try {
            decoded = await getAuth().verifyIdToken(authorization.slice(7).trim());
        } catch {
            return res.status(401).json({ error: "Invalid or expired login session" });
        }

        const auth = getAuth();
        const db = getFirestore();
        const isOwner = decoded.uid === ownerUid && decoded.firebase?.sign_in_provider !== "anonymous";

        const getRankForUser = async (uid) => {
            if (uid === ownerUid) return "OWNER";
            const snap = await db.collection("userRanks").doc(uid).get();
            const rank = snap.exists ? String(snap.data().rank || "").toUpperCase() : "";
            return VALID_RANKS.has(rank) ? rank : "VISITOR";
        };

        if (req.method === "GET") {
            const mode = typeof req.query?.mode === "string" ? req.query.mode : "mine";

            if (mode === "mine") {
                return res.status(200).json({ rank: await getRankForUser(decoded.uid) });
            }

            if (mode !== "users") {
                return res.status(400).json({ error: "Unknown rank request mode" });
            }
            if (!isOwner) {
                return res.status(403).json({ error: "Owner access required" });
            }

            const [users, rankSnapshot] = await Promise.all([
                (async () => {
                    const all = [];
                    let pageToken;
                    // Keep the Owner Panel responsive and bounded; 5,000 accounts max per request.
                    for (let page = 0; page < 5; page++) {
                        const result = await auth.listUsers(1000, pageToken);
                        all.push(...result.users);
                        pageToken = result.pageToken;
                        if (!pageToken) break;
                    }
                    return all;
                })(),
                db.collection("userRanks").get()
            ]);

            const savedRanks = new Map(
                rankSnapshot.docs.map(d => [d.id, String(d.data().rank || "").toUpperCase()])
            );
            const results = users.map(user => ({
                uid: user.uid,
                displayName: user.displayName || "",
                email: user.email || "",
                disabled: Boolean(user.disabled),
                rank: user.uid === ownerUid
                    ? "OWNER"
                    : (VALID_RANKS.has(savedRanks.get(user.uid)) ? savedRanks.get(user.uid) : "VISITOR")
            })).sort((a, b) =>
                (a.displayName || a.email || a.uid).localeCompare(b.displayName || b.email || b.uid)
            );

            return res.status(200).json({ users: results, truncated: users.length >= 5000 });
        }

        if (!isOwner) {
            return res.status(403).json({ error: "Only the owner can change ranks" });
        }

        const body = req.body || {};
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const uid = typeof body.uid === "string" ? body.uid.trim() : "";
        const rank = typeof body.rank === "string" ? body.rank.trim().toUpperCase() : "";

        if (!VALID_RANKS.has(rank)) {
            return res.status(400).json({ error: "Choose Warden, Pioneer, Resident, or Visitor. The Owner rank cannot be assigned." });
        }
        if (!email && !uid) {
            return res.status(400).json({ error: "Provide the user's Gmail address or UID" });
        }

        let target;
        try {
            target = email ? await auth.getUserByEmail(email) : await auth.getUser(uid);
        } catch {
            return res.status(404).json({ error: "No registered Firebase account was found for that email or UID" });
        }

        if (target.uid === ownerUid) {
            return res.status(400).json({ error: "The owner's rank is permanent and cannot be changed" });
        }

        await db.collection("userRanks").doc(target.uid).set({
            rank,
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: decoded.uid
        }, { merge: true });

        return res.status(200).json({
            ok: true,
            user: {
                uid: target.uid,
                displayName: target.displayName || "",
                email: target.email || "",
                rank
            }
        });
    } catch (error) {
        console.error("Rank management error:", error);
        return res.status(500).json({ error: "Rank management request failed" });
    }
}

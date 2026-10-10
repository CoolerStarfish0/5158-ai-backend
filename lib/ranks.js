const ALLOWED_ORIGIN = "https://coolerstarfish0.github.io";
const VALID_RANKS = new Set(["WARDEN", "PIONEER", "RESIDENT", "VISITOR"]);
const DEFAULT_CREDIT_LIMITS = Object.freeze({
    OWNER: null,
    WARDEN: null,
    PIONEER: null,
    RESIDENT: 5000,
    VISITOR: 1000
});

function creditState(data = {}, rank = "VISITOR") {
    const mode = data.creditLimitMode === "custom" ? "custom" : "default";
    const limit = mode === "custom"
        ? (data.creditLimit === null || data.creditLimit === undefined ? null : Math.max(0, Math.floor(Number(data.creditLimit) || 0)))
        : (DEFAULT_CREDIT_LIMITS[rank] ?? null);
    const used = Math.max(0, Math.floor(Number(data.creditsUsed) || 0));
    return {
        creditLimitMode: mode,
        creditLimit: mode === "custom" ? limit : null,
        effectiveCreditLimit: limit,
        creditsUsed: used,
        creditsRemaining: limit === null ? null : Math.max(0, limit - used)
    };
}

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
            const mode = typeof req.query?.action === "string" ? req.query.action : (typeof req.query?.mode === "string" ? req.query.mode : "mine");

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
                rankSnapshot.docs.map(d => [d.id, d.data()])
            );
            const results = users.map(user => {
                const stored = savedRanks.get(user.uid) || {};
                const storedRank = String(stored.rank || "").toUpperCase();
                const rank = user.uid === ownerUid
                    ? "OWNER"
                    : (VALID_RANKS.has(storedRank) ? storedRank : "VISITOR");
                return {
                    uid: user.uid,
                    displayName: user.displayName || "",
                    email: user.email || "",
                    disabled: Boolean(user.disabled),
                    rank,
                    ...creditState(stored, rank)
                };
            }).sort((a, b) =>
                (a.displayName || a.email || a.uid).localeCompare(b.displayName || b.email || b.uid)
            );

            return res.status(200).json({ users: results, truncated: users.length >= 5000 });
        }

        if (!isOwner) {
            return res.status(403).json({ error: "Only the owner can change ranks or credit limits" });
        }

        const body = req.body || {};

        if (body.action === "credit-limit") {
            const uidForCredits = typeof body.uid === "string" ? body.uid.trim() : "";
            if (!uidForCredits) return res.status(400).json({ error: "Provide the user's UID" });

            let targetForCredits;
            try {
                targetForCredits = await auth.getUser(uidForCredits);
            } catch {
                return res.status(404).json({ error: "No registered Firebase account was found for that UID" });
            }

            const mode = body.creditLimitMode === "custom" ? "custom" : "default";
            let creditLimit = null;
            if (mode === "custom" && body.creditLimit !== null && body.creditLimit !== undefined) {
                const parsed = Number(body.creditLimit);
                if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1000000000) {
                    return res.status(400).json({ error: "Credit limit must be a whole number from 0 to 1,000,000,000, or null for unlimited." });
                }
                creditLimit = parsed;
            }

            const targetRankSnap = await db.collection("userRanks").doc(targetForCredits.uid).get();
            const existing = targetRankSnap.data() || {};
            const storedRank = String(existing.rank || "").toUpperCase();
            const targetRank = targetForCredits.uid === ownerUid
                ? "OWNER"
                : (VALID_RANKS.has(storedRank) ? storedRank : "VISITOR");
            const creditFields = mode === "custom"
                ? { creditLimitMode: "custom", creditLimit }
                : { creditLimitMode: "default", creditLimit: FieldValue.delete() };
            await db.collection("userRanks").doc(targetForCredits.uid).set({
                ...creditFields,
                creditLimitUpdatedAt: FieldValue.serverTimestamp(),
                creditLimitUpdatedBy: decoded.uid
            }, { merge: true });

            const updatedSnap = await db.collection("userRanks").doc(targetForCredits.uid).get();
            const state = creditState(updatedSnap.data() || {}, targetRank);
            return res.status(200).json({
                ok: true,
                user: {
                    uid: targetForCredits.uid,
                    rank: targetRank,
                    ...state
                }
            });
        }

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
        const updatedRankSnapshot = await db.collection("userRanks").doc(target.uid).get();
        const updatedCreditState = creditState(updatedRankSnapshot.data() || {}, rank);

        return res.status(200).json({
            ok: true,
            user: {
                uid: target.uid,
                displayName: target.displayName || "",
                email: target.email || "",
                rank,
                ...updatedCreditState
            }
        });
    } catch (error) {
        console.error("Rank management error:", error);
        return res.status(500).json({ error: "Rank management request failed" });
    }
}

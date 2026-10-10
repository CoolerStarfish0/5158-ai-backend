const ALLOWED_ORIGIN = "https://coolerstarfish0.github.io";
const WORK_RANKS = new Set(["OWNER", "WARDEN", "PIONEER", "RESIDENT"]);

export async function enforceWorkRank(req, res) {
    const authorization = req.headers.authorization || "";
    if (!authorization.startsWith("Bearer ")) {
        res.status(401).json({ error: "Authentication required." });
        return false;
    }

    try {
        const { getApps, initializeApp, cert } = await import("firebase-admin/app");
        const { getAuth } = await import("firebase-admin/auth");
        const { getFirestore } = await import("firebase-admin/firestore");

        if (getApps().length === 0) {
            if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
                res.status(500).json({ error: "FIREBASE_SERVICE_ACCOUNT is missing." });
                return false;
            }
            initializeApp({
                credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
        }

        const decoded = await getAuth().verifyIdToken(authorization.slice(7).trim());
        const ownerUid = process.env.OWNER_UID;
        const isOwner = Boolean(
            ownerUid &&
            decoded.uid === ownerUid &&
            decoded.firebase?.sign_in_provider !== "anonymous"
        );

        let rank = "VISITOR";
        if (isOwner) {
            rank = "OWNER";
        } else {
            const snapshot = await getFirestore().collection("userRanks").doc(decoded.uid).get();
            const storedRank = String(snapshot.data()?.rank || "").toUpperCase();
            if (WORK_RANKS.has(storedRank)) rank = storedRank;
        }

        if (!WORK_RANKS.has(rank)) {
            res.status(403).json({ error: "Work Mode is available to Resident rank and above." });
            return false;
        }
        return true;
    } catch (error) {
        console.error("Work Mode rank verification failed:", error);
        res.status(401).json({ error: "Could not verify Work Mode permissions. Please sign in again." });
        return false;
    }
}

export async function getLocalAIConfig() {
    const { getApps, initializeApp, cert } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");

    let app = getApps().find(item => item.name === "[DEFAULT]");

    if (!app) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (!raw) throw new Error("Firebase Admin credentials are not configured.");
        app = initializeApp({ credential: cert(JSON.parse(raw)) });
    }

    const db = getFirestore(app);
    const snapshot = await db.collection("privateConfig").doc("localAI").get();
    const savedUrl = snapshot.exists ? String(snapshot.data()?.url || "") : "";

    return {
        localAIUrl: (savedUrl || process.env.LOCAL_AI_URL || "").replace(/\/+$/, ""),
        localAISecret: process.env.LOCAL_AI_SECRET || ""
    };
}

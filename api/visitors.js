export default async function handler(req, res) {
    const allowedOrigin = "https://coolerstarfish0.github.io";
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") return res.status(200).end();
    if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) return res.status(403).json({ error: "Origin not allowed" });
    // Share this serverless function with rank management to stay within Vercel Hobby limits.
    if (req.query?.mode === "ranks") return (await import("../lib/ranks.js")).default(req, res);
    try {
        const { getApps, initializeApp, cert } = await import("firebase-admin/app");
        const { getAuth } = await import("firebase-admin/auth");
        const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
        if (getApps().length === 0) {
            if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(500).json({ error: "FIREBASE_SERVICE_ACCOUNT is missing" });
            initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
        }
        const firebaseAuth = getAuth();
        const db = getFirestore();
        const authorization = req.headers.authorization || "";
        let decodedToken = null;
        if (authorization.startsWith("Bearer ")) {
            const idToken = authorization.slice(7).trim();
            if (!idToken) return res.status(401).json({ error: "Invalid authentication token" });
            try { decodedToken = await firebaseAuth.verifyIdToken(idToken); }
            catch { return res.status(401).json({ error: "Invalid or expired login session" }); }
        } else if (req.method === "GET") {
            return res.status(401).json({ error: "Authentication required" });
        }
        if (req.query?.mode === "chats") {
            const ownerUid = process.env.OWNER_UID;
            if (req.method === "GET") {
                if (!decodedToken || decodedToken.uid !== ownerUid || decodedToken.firebase?.sign_in_provider === "anonymous") return res.status(403).json({ error: "Owner access required" });
                const visitorId = String(req.query.visitorId || "");
                if (!/^[A-Za-z0-9_-]{8,120}$/.test(visitorId)) return res.status(400).json({ error: "Invalid visitor" });
                const snapshot = await db.collection("visitorLogs").doc(visitorId).collection("consentedChats").limit(100).get();
                const chats = await Promise.all(snapshot.docs.map(async d => { const messages = await d.ref.collection("messages").orderBy("at", "asc").limit(300).get(); return { id: d.id, ...d.data(), messages: messages.docs.map(m => m.data()) }; }));
                chats.sort((a,b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
                return res.status(200).json({ chats });
            }
            const body = req.body || {};
            if (!decodedToken || body.noticeDisplayed !== true) return res.status(403).json({ error: "Sign-in and visible chat privacy notice required" });
            const visitorId = String(body.visitorId || "");
            const chatId = String(body.chatId || "");
            if (!/^[A-Za-z0-9_-]{8,120}$/.test(visitorId) || !/^[A-Za-z0-9_-]{8,120}$/.test(chatId)) return res.status(400).json({ error: "Invalid chat identifiers" });
            const role = body.role;
            const content = body.content;
            if (!["USER", "AXON"].includes(role) || typeof content !== "string" || !content.trim() || content.length > 30000) return res.status(400).json({ error: "Invalid message" });
            const visitorRef = db.collection("visitorLogs").doc(visitorId);
            const visitor = await visitorRef.get();
            if (!visitor.exists || visitor.data().uid !== decodedToken.uid) return res.status(403).json({ error: "Visitor account mismatch" });
            const chatRef = visitorRef.collection("consentedChats").doc(chatId);
            const messageId = String(body.messageId || "");
            if (!/^[A-Za-z0-9_-]{8,120}$/.test(messageId)) return res.status(400).json({ error: "Invalid message ID" });
            const timestamp = new Date().toISOString();
            await chatRef.collection("messages").doc(messageId).set({ role, content, at: timestamp });
            await chatRef.set({ title: String(body.title || "New chat").slice(0, 90), updatedAt: timestamp, uid: decodedToken.uid }, { merge: true });
            return res.status(200).json({ ok: true });
        }
        if (req.method === "GET") {
            const ownerUid = process.env.OWNER_UID;
            if (!decodedToken || !ownerUid || decodedToken.uid !== ownerUid || decodedToken.firebase?.sign_in_provider === "anonymous") {
                return res.status(403).json({ error: "Owner access required" });
            }
            const snapshot = await db.collection("visitorLogs").orderBy("lastSeen", "desc").limit(200).get();
            const visitors = snapshot.docs.map(document => {
                const data = document.data();
                const toIso = value => value?.toDate?.()?.toISOString?.() || null;
                return {
                    id: document.id,
                    displayName: data.displayName || null,
                    email: data.email || null,
                    ip: data.ip || null,
                    accountType: data.accountType || "visitor",
                    page: data.page || "/",
                    visitCount: Number(data.visitCount) || 1,
                    firstSeen: toIso(data.firstSeen),
                    lastSeen: toIso(data.lastSeen),
                    device: data.device || null,
                    deviceHistory: Array.isArray(data.deviceHistory) ? data.deviceHistory.slice(-10) : []
                };
            });
            return res.status(200).json({ visitors });
        }
        const body = req.body || {};
        const visitorId = typeof body.visitorId === "string" ? body.visitorId : "";
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        const page = typeof body.page === "string" ? body.page.slice(0, 300) : "/";
        if (!/^[A-Za-z0-9_-]{8,120}$/.test(visitorId) || !/^[A-Za-z0-9_-]{8,120}$/.test(sessionId)) return res.status(400).json({ error: "Invalid visitor or session ID" });
        const isGuest = decodedToken?.firebase?.sign_in_provider === "anonymous";
        let account = null;
        if (decodedToken) {
            try { account = await firebaseAuth.getUser(decodedToken.uid); }
            catch { return res.status(401).json({ error: "Could not verify visitor account" }); }
        }
        const forwardedFor = req.headers["x-forwarded-for"];
        const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : typeof forwardedFor === "string" ? forwardedFor.split(",")[0].trim() : "";
        const ip = (req.headers["x-real-ip"] || forwardedIp || "").toString().slice(0, 100) || null;
        const ref = db.collection("visitorLogs").doc(visitorId);
        const previous = await ref.get();
        const previousData = previous.exists ? previous.data() : {};
        const isNewSession = !previous.exists || previousData.lastSessionId !== sessionId;
        const now = FieldValue.serverTimestamp();

        // Accept only a small, bounded set of browser-reported fields. This data
        // is diagnostic, may be approximate/spoofed, and is not proof of identity.
        const incoming = body.device && typeof body.device === "object" ? body.device : null;
        const shortText = (value, max = 120) => typeof value === "string" ? value.slice(0, max) : null;
        const finiteNumber = value => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(value, 100000)) : null;
        let device = null;
        if (incoming) {
            const screen = incoming.screen && typeof incoming.screen === "object" ? incoming.screen : {};
            const viewport = incoming.viewport && typeof incoming.viewport === "object" ? incoming.viewport : {};
            const connection = incoming.connection && typeof incoming.connection === "object" ? incoming.connection : null;
            const webgl = incoming.webgl && typeof incoming.webgl === "object" ? incoming.webgl : {};
            device = {
                reportedAt: shortText(incoming.reportedAt, 40),
                deviceType: shortText(incoming.deviceType, 20),
                os: shortText(incoming.os, 30),
                browser: shortText(incoming.browser, 30),
                platform: shortText(incoming.platform, 80),
                userAgent: shortText(incoming.userAgent, 240),
                language: shortText(incoming.language, 35),
                timezone: shortText(incoming.timezone, 80),
                screen: { width: finiteNumber(screen.width), height: finiteNumber(screen.height), colorDepth: finiteNumber(screen.colorDepth) },
                viewport: { width: finiteNumber(viewport.width), height: finiteNumber(viewport.height) },
                pixelRatio: finiteNumber(incoming.pixelRatio),
                cores: finiteNumber(incoming.cores),
                memoryGB: finiteNumber(incoming.memoryGB),
                touchPoints: finiteNumber(incoming.touchPoints),
                online: typeof incoming.online === "boolean" ? incoming.online : null,
                connection: connection ? {
                    type: shortText(connection.type, 30),
                    effectiveType: shortText(connection.effectiveType, 20),
                    downlinkMbps: finiteNumber(connection.downlinkMbps),
                    rttMs: finiteNumber(connection.rttMs),
                    saveData: typeof connection.saveData === "boolean" ? connection.saveData : null
                } : null,
                webgl: { supported: typeof webgl.supported === "boolean" ? webgl.supported : false, renderer: shortText(webgl.renderer, 120) }
            };
        }
        const update = { visitorId, ip, page, lastSessionId: sessionId, lastSeen: now, visitCount: previous.exists ? (Number(previousData.visitCount) || 1) + (isNewSession ? 1 : 0) : 1 };
        if (device) {
            const priorDevice = previousData.device || null;
            const deviceKey = value => JSON.stringify(value ? {
                deviceType: value.deviceType, os: value.os, browser: value.browser,
                platform: value.platform, screen: value.screen, cores: value.cores,
                memoryGB: value.memoryGB, webgl: value.webgl
            } : null);
            const history = Array.isArray(previousData.deviceHistory) ? previousData.deviceHistory.slice(-10) : [];
            if (!priorDevice) {
                history.push({
                    at: new Date().toISOString(),
                    deviceType: device.deviceType, os: device.os, browser: device.browser,
                    platform: device.platform, screen: device.screen, cores: device.cores,
                    memoryGB: device.memoryGB, webgl: device.webgl
                });
            } else if (deviceKey(priorDevice) !== deviceKey(device)) {
                history.push({
                    at: new Date().toISOString(),
                    deviceType: device.deviceType, os: device.os, browser: device.browser,
                    platform: device.platform, screen: device.screen, cores: device.cores,
                    memoryGB: device.memoryGB, webgl: device.webgl
                });
            }
            update.device = device;
            update.deviceHistory = history.slice(-10);
        }
        if (decodedToken) {
            update.uid = decodedToken.uid;
            update.accountType = isGuest ? "guest" : "google";
            update.email = isGuest ? null : (account?.email || null);
            update.displayName = isGuest ? null : (account?.displayName || null);
        } else if (!previous.exists) {
            update.uid = null; update.accountType = "visitor"; update.email = null; update.displayName = null;
        }
        if (!previous.exists) update.firstSeen = now;
        await ref.set(update, { merge: true });
        return res.status(200).json({ ok: true });
    } catch (error) {
        console.error("Visitor analytics error:", error);
        return res.status(500).json({ error: "Visitor analytics request failed" });
    }
}

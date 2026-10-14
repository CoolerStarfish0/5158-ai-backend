export default async function handler(req, res) {
    const allowedOrigin = "https://coolerstarfish0.github.io";
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.headers.origin && req.headers.origin !== allowedOrigin) return res.status(403).json({ error: "Origin not allowed" });
    if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });

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
        if (!authorization.startsWith("Bearer ")) return res.status(401).json({ error: "Sign in with Google to use shared chats." });
        let decoded;
        try { decoded = await firebaseAuth.verifyIdToken(authorization.slice(7).trim()); }
        catch { return res.status(401).json({ error: "Your sign-in session expired. Please sign in again." }); }
        if (!decoded.uid || decoded.firebase?.sign_in_provider === "anonymous") return res.status(403).json({ error: "Shared chats require a registered Google account." });

        let account;
        try { account = await firebaseAuth.getUser(decoded.uid); }
        catch { return res.status(401).json({ error: "Could not verify your account." }); }
        if (!account.email || account.emailVerified !== true) return res.status(403).json({ error: "Verify your account email before using shared chats." });

        const uid = decoded.uid;
        const displayName = String(account.displayName || account.email).slice(0, 100);
        const email = String(account.email).toLowerCase();
        const rooms = db.collection("sharedChats");
        const invites = db.collection("chatInvitations");
        const action = String(req.method === "GET" ? req.query?.action || "" : req.body?.action || "");

        async function requireRoomMember(chatId) {
            if (!/^[A-Za-z0-9_-]{8,120}$/.test(String(chatId || ""))) throw Object.assign(new Error("Invalid chat ID."), { status: 400 });
            const ref = rooms.doc(String(chatId));
            const snapshot = await ref.get();
            if (!snapshot.exists) throw Object.assign(new Error("Shared chat not found."), { status: 404 });
            const room = snapshot.data();
            if (!Array.isArray(room.memberUids) || !room.memberUids.includes(uid)) throw Object.assign(new Error("You are not a member of this shared chat."), { status: 403 });
            return { ref, room };
        }

        async function sendInvites(chatId, room, emailInputs) {
            if (room.ownerUid !== uid) throw Object.assign(new Error("Only the chat owner can invite people right now."), { status: 403 });
            if (!Array.isArray(emailInputs) || emailInputs.length < 1) throw Object.assign(new Error("Enter at least one email address."), { status: 400 });
            if (emailInputs.length > 20) throw Object.assign(new Error("You can invite up to 20 email addresses at once."), { status: 400 });
            const normalized = [];
            const seen = new Set();
            for (const value of emailInputs) {
                const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
                if (!candidate) continue;
                if (candidate.length > 254 || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(candidate)) {
                    normalized.push({ email: candidate.slice(0, 254), status: "invalid", message: "Invalid email format." });
                    continue;
                }
                if (seen.has(candidate)) continue;
                seen.add(candidate);
                if (candidate === email) {
                    normalized.push({ email: candidate, status: "skipped", message: "That's your own account." });
                    continue;
                }
                normalized.push({ email: candidate, status: "pending_lookup" });
            }
            const results = [];
            for (const item of normalized) {
                if (item.status !== "pending_lookup") {
                    results.push(item);
                    continue;
                }
                let recipient;
                try { recipient = await firebaseAuth.getUserByEmail(item.email); }
                catch {
                    results.push({ email: item.email, status: "not_found", message: "No Axon account exists for this email yet." });
                    continue;
                }
                if (!recipient.emailVerified) {
                    results.push({ email: item.email, status: "unverified", message: "That account must verify its email first." });
                    continue;
                }
                if ((room.memberUids || []).includes(recipient.uid)) {
                    results.push({ email: item.email, status: "already_member", message: "Already in this chat." });
                    continue;
                }
                const previous = await invites.where("chatId", "==", chatId).limit(500).get();
                const duplicate = previous.docs.find(d => d.data().recipientUid === recipient.uid && d.data().status === "pending");
                if (duplicate) {
                    results.push({ email: item.email, status: "already_pending", message: "An invitation is already pending." });
                    continue;
                }
                const inviteRef = invites.doc();
                await inviteRef.set({
                    chatId,
                    chatTitle: String(room.title || "Shared chat").slice(0, 90),
                    senderUid: uid,
                    senderName: displayName,
                    senderEmail: email,
                    recipientUid: recipient.uid,
                    recipientEmail: String(recipient.email || item.email).toLowerCase(),
                    status: "pending",
                    createdAt: new Date().toISOString()
                });
                results.push({ email: item.email, status: "sent", invitationId: inviteRef.id });
            }
            return results;
        }

        if (req.method === "GET") {
            if (action === "inbox") {
                const snapshot = await invites.where("recipientUid", "==", uid).limit(100).get();
                const invitations = snapshot.docs.map(d => ({ id: d.id, ...d.data() }))
                    .filter(item => item.status === "pending")
                    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
                return res.status(200).json({ invitations });
            }
            if (action === "list") {
                const snapshot = await rooms.where("memberUids", "array-contains", uid).limit(100).get();
                const chats = snapshot.docs.map(d => {
                    const data = d.data();
                    return { id: d.id, title: data.title || "Shared chat", ownerUid: data.ownerUid, memberUids: data.memberUids || [], members: data.members || [], createdAt: data.createdAt || null, updatedAt: data.updatedAt || data.createdAt || null };
                }).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
                return res.status(200).json({ chats });
            }
            if (action === "messages") {
                const result = await requireRoomMember(req.query?.chatId);
                const snapshot = await result.ref.collection("messages").orderBy("createdAt", "desc").limit(250).get();
                const messages = snapshot.docs.map(d => ({ id: d.id, ...d.data() })).reverse();
                return res.status(200).json({
                    chat: { id: result.ref.id, title: result.room.title || "Shared chat", ownerUid: result.room.ownerUid, memberUids: result.room.memberUids || [], members: result.room.members || [], updatedAt: result.room.updatedAt || result.room.createdAt || null },
                    messages
                });
            }
            return res.status(400).json({ error: "Unknown shared chat action." });
        }

        const body = req.body || {};
        if (action === "create") {
            const emails = body.emails;
            if (!Array.isArray(emails) || !emails.length) return res.status(400).json({ error: "Enter at least one email address to invite." });
            if (emails.length > 20) return res.status(400).json({ error: "You can invite up to 20 email addresses at once." });
            const title = String(body.title || "Shared chat").trim().slice(0, 90) || "Shared chat";
            const roomRef = rooms.doc();
            const now = new Date().toISOString();
            const member = { uid, email, displayName };
            const room = { title, ownerUid: uid, ownerName: displayName, memberUids: [uid], members: [member], createdAt: now, updatedAt: now };
            await roomRef.set(room);
            const initialMessages = Array.isArray(body.messages) ? body.messages.slice(-100) : [];
            let index = 0;
            for (const message of initialMessages) {
                if (!message || !["USER", "AXON"].includes(message.role) || typeof message.content !== "string" || !message.content.trim()) continue;
                index++;
                await roomRef.collection("messages").doc("initial_" + String(index).padStart(3, "0")).set({
                    role: message.role,
                    content: message.content.slice(0, 20000),
                    senderUid: uid,
                    senderName: message.role === "AXON" ? "Axon" : displayName,
                    createdAt: now,
                    imported: true
                });
            }
            const results = await sendInvites(roomRef.id, room, emails);
            return res.status(201).json({ chat: { id: roomRef.id, ...room }, results });
        }

        if (action === "invite") {
            const result = await requireRoomMember(body.chatId);
            const results = await sendInvites(result.ref.id, result.room, body.emails);
            return res.status(200).json({ results });
        }

        if (action === "respond") {
            const invitationId = String(body.invitationId || "");
            const responseStatus = String(body.response || "");
            if (!/^[A-Za-z0-9_-]{10,120}$/.test(invitationId) || !["accepted", "declined"].includes(responseStatus)) return res.status(400).json({ error: "Invalid invitation response." });
            const inviteRef = invites.doc(invitationId);
            const inviteSnapshot = await inviteRef.get();
            if (!inviteSnapshot.exists) return res.status(404).json({ error: "Invitation not found." });
            const invite = inviteSnapshot.data();
            if (invite.recipientUid !== uid || String(invite.recipientEmail || "").toLowerCase() !== email) return res.status(403).json({ error: "This invitation belongs to another account." });
            if (invite.status !== "pending") return res.status(409).json({ error: "This invitation has already been answered." });
            const roomRef = rooms.doc(String(invite.chatId || ""));
            const roomSnapshot = await roomRef.get();
            if (!roomSnapshot.exists) {
                await inviteRef.update({ status: "declined", respondedAt: new Date().toISOString() });
                return res.status(404).json({ error: "The shared chat no longer exists." });
            }
            const room = roomSnapshot.data();
            if (responseStatus === "accepted") {
                const member = { uid, email, displayName };
                await roomRef.update({
                    memberUids: FieldValue.arrayUnion(uid),
                    members: FieldValue.arrayUnion(member),
                    updatedAt: new Date().toISOString()
                });
            }
            await inviteRef.update({ status: responseStatus, respondedAt: new Date().toISOString() });
            return res.status(200).json({ ok: true, response: responseStatus, chatId: invite.chatId, title: room.title || invite.chatTitle || "Shared chat" });
        }

        if (action === "sendMessage") {
            const result = await requireRoomMember(body.chatId);
            const role = String(body.role || "USER");
            const content = typeof body.content === "string" ? body.content.trim() : "";
            const images = body.images === undefined ? [] : body.images;
            if (!["USER", "AXON"].includes(role) || (!content && !Array.isArray(images)) || content.length > 20000) return res.status(400).json({ error: "Invalid message." });
            if (!Array.isArray(images) || images.length > 3) return res.status(400).json({ error: "Attach up to 3 images per message." });
            for (const image of images) {
                if (!image || image.mimeType !== "image/jpeg" || typeof image.data !== "string" || image.data.length > 560000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
                    return res.status(400).json({ error: "An image attachment is invalid or too large." });
                }
            }
            const now = new Date().toISOString();
            const messageRef = result.ref.collection("messages").doc();
            await messageRef.set({
                role,
                content: content || "Please look at the attached image(s).",
                ...(images.length ? { images: images.map(image => ({ name: String(image.name || "image").slice(0,120), mimeType: "image/jpeg", data: image.data })) } : {}),
                senderUid: uid,
                senderName: role === "AXON" ? "Axon" : displayName,
                createdAt: now
            });
            await result.ref.update({ updatedAt: now });
            return res.status(201).json({ ok: true, messageId: messageRef.id, createdAt: now });
        }

        return res.status(400).json({ error: "Unknown shared chat action." });
    } catch (error) {
        if (error && Number.isInteger(error.status)) return res.status(error.status).json({ error: error.message });
        console.error("Shared chat API error:", error);
        return res.status(500).json({ error: "Shared chat request failed." });
    }
}
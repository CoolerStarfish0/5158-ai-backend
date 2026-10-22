import crypto from "node:crypto";

const FRONTEND_URL = process.env.AXON_FRONTEND_URL || "https://coolerstarfish0.github.io/my-ai/";
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "https://5158-ai-backendpriv.vercel.app/api/google?action=callback";
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.compose"
];

function sendError(res, status, error) {
  return res.status(status).json({ error });
}
function redirect(res, query) {
  return res.redirect(302, FRONTEND_URL + (FRONTEND_URL.includes("?") ? "&" : "?") + query);
}
function getAdmin() {
  return import("firebase-admin/app").then(async ({ getApps, initializeApp, cert }) => {
    if (getApps().length === 0) {
      if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error("FIREBASE_SERVICE_ACCOUNT is missing.");
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    const [{ getAuth }, { getFirestore }] = await Promise.all([
      import("firebase-admin/auth"), import("firebase-admin/firestore")
    ]);
    return { auth: getAuth(), db: getFirestore() };
  });
}
async function requireOwner(req) {
  const authorization = String(req.headers.authorization || "");
  if (!authorization.startsWith("Bearer ")) throw Object.assign(new Error("Sign in with your owner account first."), { status: 401 });
  const { auth, db } = await getAdmin();
  let decoded;
  try { decoded = await auth.verifyIdToken(authorization.slice(7).trim()); }
  catch { throw Object.assign(new Error("Your login session expired. Sign in again."), { status: 401 }); }
  if (!process.env.OWNER_UID || decoded.uid !== process.env.OWNER_UID || decoded.firebase?.sign_in_provider === "anonymous") {
    throw Object.assign(new Error("Owner access is required for Google integrations."), { status: 403 });
  }
  return { uid: decoded.uid, db };
}
function encryptionKey() {
  const raw = String(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || "");
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY must be a 32-byte base64 or 64-character hex key.");
  return key;
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), data: encrypted.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
function decrypt(value) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString("utf8");
}
async function googleFetch(url, accessToken, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: "Bearer " + accessToken, ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Google API " + response.status + ": " + (data.error?.message || data.error_description || "Request failed"));
  return data;
}
async function getAccessToken(db, uid) {
  const ref = db.collection("axon_google_connections").doc(uid);
  const snap = await ref.get();
  if (!snap.exists || !snap.data()?.encryptedRefreshToken) throw Object.assign(new Error("Google is not connected. Use Connect Google in Axon first."), { status: 409 });
  const refreshToken = decrypt(snap.data().encryptedRefreshToken);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error("Google token refresh failed: " + (data.error_description || data.error || "Check Google OAuth setup."));
  return data.access_token;
}
function requireString(value, label, max = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(label + " is required (maximum " + max + " characters).");
  return value.trim();
}
function requireConfirmed(body) {
  if (body.confirmed !== true) throw Object.assign(new Error("Axon needs your confirmation before creating or changing Google content."), { status: 400 });
}
async function executeGoogleAction(db, uid, body) {
  const action = String(body.action || "");
  const accessToken = await getAccessToken(db, uid);
  if (action === "drive_search") {
    const query = requireString(body.query, "Search query", 300);
    const q = "trashed = false and name contains '" + query.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
    const data = await googleFetch("https://www.googleapis.com/drive/v3/files?fields=files(id,name,mimeType,webViewLink,modifiedTime)&pageSize=20&orderBy=modifiedTime%20desc&q=" + encodeURIComponent(q), accessToken);
    return { action, files: (data.files || []).map(file => ({ id: file.id, name: file.name, type: file.mimeType, url: file.webViewLink, modifiedTime: file.modifiedTime })) };
  }
  if (action === "classroom_list_courses") {
    const data = await googleFetch("https://classroom.googleapis.com/v1/courses?pageSize=100&courseStates=ACTIVE", accessToken);
    return { action, courses: (data.courses || []).map(course => ({ id: course.id, name: course.name, section: course.section || "", state: course.courseState })) };
  }
  if (action === "classroom_list_students") {
    const courseId = requireString(String(body.courseId || ""), "Course ID", 100);
    const data = await googleFetch("https://classroom.googleapis.com/v1/courses/" + encodeURIComponent(courseId) + "/students?pageSize=100", accessToken);
    return { action, courseId, students: (data.students || []).map(student => ({ id: student.userId, name: student.profile?.name?.fullName || "" })) };
  }
  if (action === "google_create_doc") {
    requireConfirmed(body);
    const title = requireString(body.title, "Document title", 200);
    const text = requireString(body.text, "Document text", 50000);
    const doc = await googleFetch("https://docs.googleapis.com/v1/documents", accessToken, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
    await googleFetch("https://docs.googleapis.com/v1/documents/" + encodeURIComponent(doc.documentId) + ":batchUpdate", accessToken, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text } }] })
    });
    return { action, title, documentId: doc.documentId, url: "https://docs.google.com/document/d/" + doc.documentId + "/edit" };
  }
  if (action === "google_create_sheet") {
    requireConfirmed(body);
    const title = requireString(body.title, "Spreadsheet title", 200);
    if (!Array.isArray(body.values) || !body.values.length || body.values.length > 500) throw new Error("Provide a non-empty values array with up to 500 rows.");
    const values = body.values.map(row => {
      if (!Array.isArray(row) || row.length > 50) throw new Error("Each spreadsheet row must be an array of at most 50 cells.");
      return row.map(cell => String(cell ?? "").slice(0, 5000));
    });
    const sheet = await googleFetch("https://sheets.googleapis.com/v4/spreadsheets", accessToken, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ properties: { title } })
    });
    await googleFetch("https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(sheet.spreadsheetId) + "/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", accessToken, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values })
    });
    return { action, title, spreadsheetId: sheet.spreadsheetId, url: sheet.spreadsheetUrl };
  }
  if (action === "google_create_form") {
    requireConfirmed(body);
    const title = requireString(body.title, "Form title", 200);
    const question = requireString(body.question, "Form question", 500);
    if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 100) throw new Error("A multiple-choice form needs 2–100 options.");
    const options = body.options.map(value => ({ value: requireString(String(value), "Option", 300) }));
    const form = await googleFetch("https://forms.googleapis.com/v1/forms", accessToken, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ info: { title, documentTitle: title } })
    });
    await googleFetch("https://forms.googleapis.com/v1/forms/" + encodeURIComponent(form.formId) + ":batchUpdate", accessToken, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ createItem: { item: { title: question, questionItem: { question: { required: false, choiceQuestion: { type: "RADIO", options } } } }, location: { index: 0 } } }] })
    });
    return { action, title, formId: form.formId, url: form.responderUri || "https://docs.google.com/forms/d/" + form.formId + "/edit", editUrl: "https://docs.google.com/forms/d/" + form.formId + "/edit" };
  }
  if (action === "calendar_create_event") {
    requireConfirmed(body);
    const summary = requireString(body.summary, "Event title", 200);
    const start = requireString(body.start, "Start date/time", 100);
    const end = requireString(body.end, "End date/time", 100);
    const event = await googleFetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", accessToken, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary, description: String(body.description || "").slice(0, 5000), start: { dateTime: start }, end: { dateTime: end } })
    });
    return { action, id: event.id, summary, url: event.htmlLink };
  }
  if (action === "gmail_create_draft") {
    requireConfirmed(body);
    const to = requireString(body.to, "Recipient email", 320);
    const subject = requireString(body.subject, "Email subject", 300);
    const text = requireString(body.text, "Email body", 30000);
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(to)) throw new Error("Recipient email is invalid.");
    const raw = "To: " + to + "\\r\\nSubject: " + subject + "\\r\\nContent-Type: text/plain; charset=UTF-8\\r\\n\\r\\n" + text;
    const encoded = Buffer.from(raw, "utf8").toString("base64url");
    const draft = await googleFetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", accessToken, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: { raw: encoded } })
    });
    return { action, draftId: draft.id, message: "Draft saved in Gmail. It has not been sent." };
  }
  throw Object.assign(new Error("Unsupported Google action: " + action), { status: 400 });
}

export default async function handler(req, res) {
  const allowedOrigin = "https://coolerstarfish0.github.io";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.headers.origin && req.headers.origin !== allowedOrigin) return sendError(res, 403, "Origin not allowed.");
  const action = String(req.query?.action || "");
  if (action === "callback" && req.method === "GET") {
    try {
      if (req.query?.error) return redirect(res, "google_error=" + encodeURIComponent(String(req.query.error).slice(0, 100)));
      const state = String(req.query?.state || "");
      if (!/^[a-f0-9]{64}$/.test(state)) return redirect(res, "google_error=invalid_state");
      const { db } = await getAdmin();
      const stateRef = db.collection("axon_google_oauth_states").doc(state);
      const stateSnap = await stateRef.get();
      if (!stateSnap.exists || Date.now() - Number(stateSnap.data()?.createdAt || 0) > 10 * 60 * 1000) {
        return redirect(res, "google_error=expired_state");
      }
      await stateRef.delete();
      const code = String(req.query?.code || "");
      if (!code || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return redirect(res, "google_error=oauth_not_configured");
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" })
      });
      const tokens = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || !tokens.access_token) return redirect(res, "google_error=token_exchange_failed");
      const tokenData = { encryptedRefreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null, connectedAt: Date.now(), scope: String(tokens.scope || ""), email: "" };
      const access = tokens.access_token;
      try {
        const profile = await googleFetch("https://www.googleapis.com/oauth2/v2/userinfo", access);
        tokenData.email = String(profile.email || "").slice(0, 320);
      } catch {}
      const connectionRef = db.collection("axon_google_connections").doc(String(stateSnap.data().uid));
      const existing = await connectionRef.get();
      if (!tokenData.encryptedRefreshToken && existing.exists) tokenData.encryptedRefreshToken = existing.data().encryptedRefreshToken;
      if (!tokenData.encryptedRefreshToken) return redirect(res, "google_error=missing_refresh_token");
      await connectionRef.set(tokenData, { merge: true });
      return redirect(res, "google_connected=1");
    } catch (error) {
      console.error("Axon Google OAuth callback failed:", error);
      return redirect(res, "google_error=callback_failed");
    }
  }
  if (req.method !== "GET" && req.method !== "POST") return sendError(res, 405, "Method not allowed.");
  try {
    const { uid, db } = await requireOwner(req);
    if (action === "start" && req.method === "GET") {
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return sendError(res, 503, "Google OAuth isn't configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel.");
      const state = crypto.randomBytes(32).toString("hex");
      await db.collection("axon_google_oauth_states").doc(state).set({ uid, createdAt: Date.now() });
      const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", access_type: "offline", prompt: "consent", include_granted_scopes: "true", scope: SCOPES.join(" "), state });
      return res.status(200).json({ url: "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString() });
    }
    if (action === "status" && req.method === "GET") {
      const snap = await db.collection("axon_google_connections").doc(uid).get();
      return res.status(200).json({ connected: Boolean(snap.exists && snap.data()?.encryptedRefreshToken), email: snap.data()?.email || null, scopes: snap.data()?.scope || "" });
    }
    if (action === "disconnect" && req.method === "POST") {
      await db.collection("axon_google_connections").doc(uid).delete();
      return res.status(200).json({ disconnected: true });
    }
    if (action === "tool" && req.method === "POST") {
      const body = req.body || {};
      const result = await executeGoogleAction(db, uid, body);
      return res.status(200).json(result);
    }
    return sendError(res, 400, "Unknown Google action.");
  } catch (error) {
    console.error("Axon Google integration error:", error);
    return sendError(res, error.status || 500, error.message || "Google integration failed.");
  }
}

import crypto from "node:crypto";

const FRONTEND_URL = process.env.AXON_FRONTEND_URL || "https://coolerstarfish0.github.io/my-ai/";
const REDIRECT_URI = process.env.CANVA_REDIRECT_URI || "https://5158-ai-backendpriv.vercel.app/api/canva";
const DEFAULT_SCOPES = [
  "design:meta:read", "design:content:read", "design:content:write",
  "asset:read", "asset:write", "folder:read", "folder:write", "profile:read"
];
const ORIGIN = "https://coolerstarfish0.github.io";

function err(res, status, error) { return res.status(status).json({ error }); }
function front(res, q) {
  return res.redirect(302, FRONTEND_URL + (FRONTEND_URL.includes("?") ? "&" : "?") + q);
}
async function admin() {
  const a = await import("firebase-admin/app");
  if (a.getApps().length === 0) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw Error("FIREBASE_SERVICE_ACCOUNT is missing.");
    a.initializeApp({ credential: a.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  const [{ getFirestore }, { getAuth }] = await Promise.all([
    import("firebase-admin/firestore"), import("firebase-admin/auth")
  ]);
  return { db: getFirestore(), auth: getAuth() };
}
async function userFor(req) {
  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Bearer ")) throw Object.assign(Error("Sign in to Axon before connecting Canva."), { status: 401 });
  const { db, auth } = await admin();
  let u;
  try { u = await auth.verifyIdToken(h.slice(7).trim()); }
  catch { throw Object.assign(Error("Your Axon login expired. Sign in again."), { status: 401 }); }
  if (u.firebase?.sign_in_provider === "anonymous" || u.email_verified !== true || !u.email) {
    throw Object.assign(Error("Sign in with a verified email to connect Canva."), { status: 403 });
  }
  return { uid: u.uid, db };
}
function key() {
  const raw = String(process.env.CANVA_TOKEN_ENCRYPTION_KEY || process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || "");
  if (raw) {
    const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (k.length === 32) return k;
  }
  const secret = String(process.env.CANVA_CLIENT_SECRET || "");
  if (!secret) throw Error("CANVA_CLIENT_SECRET is missing; token encryption cannot be initialized.");
  return crypto.createHash("sha256").update("axon-canva-token-encryption-v1:" + secret).digest();
}
function encrypt(s) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), data: data.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
function decrypt(value) {
  if (!value?.iv || !value?.data || !value?.tag) throw Error("Saved Canva credentials are incomplete. Reconnect Canva.");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(value.iv, "base64"));
  d.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(value.data, "base64")), d.final()]).toString("utf8");
}
async function getConnection(db, uid) {
  const ref = db.collection("axon_canva_connections").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(Error("Canva is not connected. Connect Canva first."), { status: 409 });
  return { ref, data: snap.data() || {} };
}
async function canvaAccessToken(db, uid) {
  const { ref, data } = await getConnection(db, uid);
  if (!data.encryptedRefreshToken) throw Object.assign(Error("Canva authorization expired. Disconnect and reconnect Canva."), { status: 409 });
  if (data.encryptedAccessToken && Number(data.accessTokenExpiresAt || 0) > Date.now() + 30000) {
    return decrypt(data.encryptedAccessToken);
  }
  const basic = Buffer.from(String(process.env.CANVA_CLIENT_ID) + ":" + String(process.env.CANVA_CLIENT_SECRET)).toString("base64");
  const response = await fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: decrypt(data.encryptedRefreshToken) })
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || !token.access_token) {
    console.error("Canva refresh failed", response.status, token.error || token.message || "unknown");
    throw Object.assign(Error("Canva authorization expired or could not refresh. Disconnect and reconnect Canva."), { status: 401 });
  }
  const updated = {
    encryptedAccessToken: encrypt(token.access_token),
    accessTokenExpiresAt: Date.now() + Math.max(0, Number(token.expires_in || 0) - 60) * 1000,
    refreshedAt: Date.now()
  };
  if (token.refresh_token) updated.encryptedRefreshToken = encrypt(token.refresh_token);
  await ref.set(updated, { merge: true });
  return token.access_token;
}

function safeTopic(prompt) {
  return String(prompt || "").replace(/\\s+/g, " ").trim().slice(0, 180) || "An educational topic";
}
function makePresentationSlides(prompt) {
  const topic = safeTopic(prompt)
    .replace(/^(please\\s+)?(can you\\s+|could you\\s+|help me\\s+)?(make|create|design|build|generate|produce)\\s+(me\\s+)?/i, "")
    .replace(/\\b(in|on|using|with)\\s+canva\\b/ig, "").replace(/[.!?]+$/, "").trim();
  if (/photosynth|carbon dioxide|\\bco2\\b/i.test(topic)) return [
    {title:"The role of carbon dioxide in photosynthesis", subtitle:"How plants turn light into stored chemical energy", points:["Photosynthesis happens mainly in the leaves.","Plants use light energy to make glucose.","Carbon dioxide supplies the carbon atoms used to build sugars."], visual:"CO₂ + water + light → glucose + oxygen"},
    {title:"Where does CO₂ enter?", points:["Carbon dioxide in the air enters leaves through tiny pores called stomata.","The gas diffuses into the leaf's internal air spaces.","CO₂ then reaches photosynthetic cells containing chloroplasts."], visual:"AIR  →  STOMATA  →  LEAF CELLS"},
    {title:"Inside the chloroplast", points:["Chlorophyll absorbs light energy.","Light-dependent reactions help provide energy for sugar production.","The Calvin cycle uses CO₂ to build carbon-containing molecules."], visual:"SUNLIGHT → CHLOROPLAST → SUGAR"},
    {title:"The photosynthesis equation", points:["Carbon dioxide and water are the raw materials.","Light energy drives the process.","Glucose stores chemical energy; oxygen is released."], visual:"6 CO₂ + 6 H₂O + light → C₆H₁₂O₆ + 6 O₂"},
    {title:"Why carbon dioxide matters", points:["CO₂ provides the carbon used to make glucose and other organic molecules.","Glucose supports growth and can be stored as starch.","Too little CO₂ can limit the rate of photosynthesis when other conditions are suitable."], visual:"CO₂ → GLUCOSE → GROWTH"},
    {title:"Key takeaways", points:["CO₂ enters leaves through stomata.","Chloroplasts use light energy to help convert CO₂ into sugars.","Photosynthesis supports plant growth and releases oxygen."], visual:"LIGHT + CO₂ + WATER → PLANT FOOD"}
  ];
  const clean = topic.charAt(0).toUpperCase()+topic.slice(1);
  return [
    {title:clean, subtitle:"A clear, visual introduction", points:["What the topic means and why it matters.","The key idea to understand first.","A quick guide to what this presentation covers."], visual:"INTRODUCTION"},
    {title:"The main ideas", points:["Identify the most important concepts and define them clearly.","Connect each idea to the central topic.","Use examples to make abstract ideas easier to understand."], visual:"IDEA 1  →  IDEA 2  →  IDEA 3"},
    {title:"How it works", points:["Break the process into simple, ordered steps.","Explain what causes each step and what happens next.","Look for relationships between the parts."], visual:"INPUT  →  PROCESS  →  RESULT"},
    {title:"Real-world examples", points:["Connect the topic to an everyday situation.","Compare a simple example with a more complex one.","Ask what the example reveals about the main idea."], visual:"CONCEPT + EXAMPLE = UNDERSTANDING"},
    {title:"Why it matters", points:["Consider the effects on people, nature, technology, or society as relevant.","Separate established facts from opinions or predictions.","Think about benefits, limitations, and open questions."], visual:"IMPACT • EVIDENCE • QUESTIONS"},
    {title:"Summary", points:["Remember the central idea.","Review the three most important takeaways.","Use the key question to check your understanding."], visual:"LEARN  →  CONNECT  →  APPLY"}
  ];
}
async function buildPresentationPptx(prompt, title) {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Axon";
  pptx.subject = "AI-generated educational presentation";
  pptx.title = title;
  pptx.company = "Axon";
  pptx.lang = "en-US";
  pptx.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos", lang: "en-US" };
  const slides = makePresentationSlides(prompt);
  slides.forEach((data, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: index === 0 ? "10213B" : "F5F8FC" };
    const dark = index === 0;
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, line: { color: "25B7A5", transparency: 100 }, fill: { color: "25B7A5" } });
    slide.addText("AXON • LEARN VISUALLY", { x: 0.55, y: 0.28, w: 5.8, h: 0.28, fontFace: "Aptos", fontSize: 10, bold: true, charSpacing: 1.4, color: dark ? "65E0D0" : "168A83", margin: 0 });
    slide.addText(data.title, { x: 0.6, y: 0.78, w: 11.8, h: index === 0 ? 1.45 : 0.95, fontFace: "Aptos Display", fontSize: index === 0 ? 30 : 26, bold: true, color: dark ? "FFFFFF" : "10213B", breakLine: false, fit: "shrink", margin: 0.03 });
    if (data.subtitle) slide.addText(data.subtitle, { x: 0.65, y: 2.18, w: 10.9, h: 0.65, fontSize: 18, color: "D6E5F5", breakLine: false, fit: "shrink", margin: 0.02 });
    const pts = data.points || [];
    pts.forEach((point, i) => {
      const y = (index === 0 ? 3.05 : 2.05) + i * 0.88;
      slide.addShape(pptx.ShapeType.ellipse, { x: 0.72, y: y + 0.08, w: 0.24, h: 0.24, line: { color: "25B7A5", transparency: 100 }, fill: { color: "25B7A5" } });
      slide.addText(point, { x: 1.12, y, w: 10.7, h: 0.66, fontSize: 17, color: dark ? "F0F5FF" : "24364D", breakLine: false, fit: "shrink", valign: "mid", margin: 0.03 });
    });
    const vy = index === 0 ? 5.95 : 5.25;
    slide.addShape(pptx.ShapeType.roundRect, { x: 0.7, y: vy, w: 11.85, h: 0.88, rectRadius: 0.12, line: { color: dark ? "44708C" : "C5D9E8", width: 1 }, fill: { color: dark ? "193650" : "E5F5F3" } });
    slide.addText(data.visual || "KEY IDEA", { x: 0.95, y: vy + 0.2, w: 11.3, h: 0.45, fontSize: 19, bold: true, align: "center", valign: "mid", color: dark ? "65E0D0" : "167E79", fit: "shrink", margin: 0.02 });
    slide.addText(String(index + 1).padStart(2,"0") + "  /  " + String(slides.length).padStart(2,"0"), { x: 11.3, y: 7.1, w: 1.1, h: 0.2, fontSize: 9, color: dark ? "B4C7DC" : "718096", align: "right", margin: 0 });
  });
  return await pptx.write({ outputType: "nodebuffer" });
}
async function importPresentationToCanva(db, uid, buffer, title) {
  const token = await canvaAccessToken(db, uid);
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }), title.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 80) + ".pptx");
  const response = await fetch("https://api.canva.com/rest/v1/imports", {
    method: "POST", headers: { Authorization: "Bearer " + token, Accept: "application/json" }, body: form
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Canva presentation import failed", response.status, payload.code || payload.error || payload.message || "unknown");
    throw Object.assign(Error(response.status === 403
      ? "Canva denied presentation import. Reconnect Canva and verify design:content:write is approved."
      : "Canva couldn't import the generated presentation. Check Canva's supported import formats and permissions."), { status: response.status === 403 ? 403 : 502 });
  }
  let job = payload.job || payload;
  const jobId = job.id || job.job_id;
  for (let i = 0; i < 8 && jobId && !job.design; i++) {
    if (String(job.status || "").toLowerCase() === "failed") throw Error("Canva could not convert the presentation file.");
    if (String(job.status || "").toLowerCase() === "success" || job.design) break;
    await new Promise(resolve => setTimeout(resolve, 900));
    const check = await fetch("https://api.canva.com/rest/v1/imports/" + encodeURIComponent(jobId), { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    const checked = await check.json().catch(() => ({}));
    if (!check.ok) break;
    job = checked.job || checked;
  }
  const design = job.design || payload.design || null;
  if (!design) throw Error("Canva accepted the presentation file, but its import is still processing. Try listing your Canva designs in a moment.");
  return design;
}

async function canvaRequest(db, uid, path, options = {}) {
  const token = await canvaAccessToken(db, uid);
  const response = await fetch("https://api.canva.com/rest/v1" + path, {
    ...options,
    headers: { Authorization: "Bearer " + token, Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Canva API request failed", response.status, payload.code || payload.error || payload.message || "unknown");
    const status = response.status === 401 ? 401 : response.status === 403 ? 403 : response.status === 429 ? 429 : 502;
    throw Object.assign(Error(response.status === 403 ? "Canva denied this action. Check the app's approved scopes and permissions." : response.status === 429 ? "Canva is rate-limiting requests. Try again shortly." : "Canva request failed. Check that the app has the required permissions."), { status });
  }
  return payload;
}
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.headers.origin && req.headers.origin !== ORIGIN) return err(res, 403, "Origin not allowed.");
  const pathname = String(req.url || "").split("?")[0].replace(/\/+$/, "");
  const isCallbackPath = pathname === "/api/canva/callback";
  const rawUrl = String(req.url || "");
  const rawCodeMatch = rawUrl.match(/[?&]code=([^&]+)/);
  const rawStateMatch = rawUrl.match(/[?&]state=([^&]+)/);
  const actionValue = String(req.query?.action || "");
  const hasOAuthCallbackParams = Boolean((req.query?.code || rawCodeMatch) && (req.query?.state || rawStateMatch));
  const action = isCallbackPath || actionValue === "callback" || actionValue.startsWith("callback?") || (!actionValue && hasOAuthCallbackParams) ? "callback" : actionValue;

  if (action === "callback" && req.method === "GET") {
    try {
      if (req.query?.error) return front(res, "canva_error=" + encodeURIComponent(String(req.query.error).slice(0, 100)));
      const rawUrl = String(req.url || "");
      const rawCodeMatch = rawUrl.match(/[?&]code=([^&]+)/);
      const rawStateMatch = rawUrl.match(/[?&]state=([^&]+)/);
      const state = String(req.query?.state || (rawStateMatch ? decodeURIComponent(rawStateMatch[1]) : ""));
      if (!/^[a-f0-9]{64}$/.test(state)) return front(res, "canva_error=invalid_state");
      const { db } = await admin();
      const ref = db.collection("axon_canva_oauth_states").doc(state);
      const snap = await ref.get();
      const sd = snap.data() || {};
      if (!snap.exists || !sd.uid || !sd.codeVerifier || Date.now() - Number(sd.createdAt || 0) > 600000) {
        if (snap.exists) await ref.delete();
        return front(res, "canva_error=expired_state");
      }
      await ref.delete();
      const code = String(req.query?.code || (rawCodeMatch ? decodeURIComponent(rawCodeMatch[1]) : ""));
      if (!code || !process.env.CANVA_CLIENT_ID || !process.env.CANVA_CLIENT_SECRET) return front(res, "canva_error=oauth_not_configured");
      const basic = Buffer.from(process.env.CANVA_CLIENT_ID + ":" + process.env.CANVA_CLIENT_SECRET).toString("base64");
      const response = await fetch("https://api.canva.com/rest/v1/oauth/token", {
        method: "POST",
        headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: sd.codeVerifier })
      });
      const token = await response.json().catch(() => ({}));
      if (!response.ok || !token.access_token) {
        console.error("Canva token exchange failed", response.status, token.error || token.message || "unknown");
        return front(res, "canva_error=token_exchange_failed");
      }
      const connectionRef = db.collection("axon_canva_connections").doc(String(sd.uid));
      const old = await connectionRef.get();
      const saved = {
        encryptedAccessToken: encrypt(token.access_token),
        encryptedRefreshToken: token.refresh_token ? encrypt(token.refresh_token) : (old.data()?.encryptedRefreshToken || null),
        accessTokenExpiresAt: Date.now() + Math.max(0, Number(token.expires_in || 0) - 60) * 1000,
        connectedAt: Date.now(), scope: String(token.scope || ""), userId: String(token.user_id || "")
      };
      if (!saved.encryptedRefreshToken) return front(res, "canva_error=missing_refresh_token");
      await connectionRef.set(saved, { merge: true });
      return front(res, "canva_connected=1");
    } catch (e) {
      console.error("Canva OAuth callback failed", e);
      return front(res, "canva_error=callback_failed");
    }
  }

  if (req.method !== "GET" && req.method !== "POST") return err(res, 405, "Method not allowed.");
  try {
    const { uid, db } = await userFor(req);
    if (action === "start" && req.method === "GET") {
      if (!process.env.CANVA_CLIENT_ID || !process.env.CANVA_CLIENT_SECRET) return err(res, 503, "Canva OAuth is not configured. Check CANVA_CLIENT_ID and CANVA_CLIENT_SECRET in Vercel.");
      const state = crypto.randomBytes(32).toString("hex");
      const verifier = crypto.randomBytes(48).toString("base64url");
      await db.collection("axon_canva_oauth_states").doc(state).set({ uid, codeVerifier: verifier, createdAt: Date.now() });
      const scopes = String(process.env.CANVA_SCOPES || DEFAULT_SCOPES.join(" ")).trim().replace(/,/g, " ");
      const params = new URLSearchParams({
        client_id: process.env.CANVA_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code",
        scope: scopes, state, code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256"
      });
      return res.status(200).json({ url: "https://www.canva.com/api/oauth/authorize?" + params.toString() });
    }
    if (action === "status" && req.method === "GET") {
      const snap = await db.collection("axon_canva_connections").doc(uid).get();
      const data = snap.data() || {};
      return res.status(200).json({ connected: Boolean(snap.exists && data.encryptedRefreshToken), scopes: data.scope || "", connectedAt: data.connectedAt || null });
    }
    if (action === "disconnect" && req.method === "POST") {
      await db.collection("axon_canva_connections").doc(uid).delete();
      return res.status(200).json({ disconnected: true });
    }
    if (action === "designs" && req.method === "GET") {
      const params = new URLSearchParams();
      const query = String(req.query?.query || "").trim().slice(0, 160);
      const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 20)));
      if (query) params.set("query", query);
      params.set("limit", String(limit));
      if (req.query?.continuation) params.set("continuation", String(req.query.continuation).slice(0, 500));
      const result = await canvaRequest(db, uid, "/designs?" + params.toString());
      return res.status(200).json({ items: Array.isArray(result.items) ? result.items : [], continuation: result.continuation || null });
    }

    if (action === "create-presentation" && req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const prompt = safeTopic(body.prompt || body.title);
      const title = String(body.title || prompt).trim().slice(0, 100) || "Axon Presentation";
      const pptx = await buildPresentationPptx(prompt, title);
      const design = await importPresentationToCanva(db, uid, pptx, title);
      return res.status(201).json({ design, imported: true, slideCount: 6 });
    }

    if (action === "create-design" && req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const title = String(body.title || "").trim().slice(0, 100);
      const preset = String(body.designType || "doc");
      const allowed = new Set(["doc", "whiteboard", "presentation", "video", "social_media", "print", "website", "email"]);
      if (!title) return err(res, 400, "Enter a title for the Canva design.");
      if (!allowed.has(preset)) return err(res, 400, "Choose a supported design type.");
      const result = await canvaRequest(db, uid, "/designs", {
        method: "POST",
        body: JSON.stringify({ design_type: { type: "preset", name: preset }, title })
      });
      return res.status(201).json({ design: result.design || result });
    }
    return err(res, 400, "Unknown Canva action.");
  } catch (e) {
    console.error("Canva integration error", e);
    return err(res, e.status || 500, e.message || "Canva integration failed.");
  }
}

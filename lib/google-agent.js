import crypto from "node:crypto";

const FRONTEND_URL = process.env.AXON_FRONTEND_URL || "https://coolerstarfish0.github.io/my-ai/";
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "https://5158-ai-backendpriv.vercel.app/api/agent?mode=google&action=callback";
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
  if (!authorization.startsWith("Bearer ")) throw Object.assign(new Error("Sign in with an approved Google account first."), { status: 401 });
  const { auth, db } = await getAdmin();
  let decoded;
  try { decoded = await auth.verifyIdToken(authorization.slice(7).trim()); }
  catch { throw Object.assign(new Error("Your login session expired. Sign in again."), { status: 401 }); }

  const isAnonymous = decoded.firebase?.sign_in_provider === "anonymous";
  const isOwner = Boolean(process.env.OWNER_UID) && decoded.uid === process.env.OWNER_UID;
  const approvedEmails = String(process.env.GOOGLE_TESTER_EMAILS || "")
    .split(",")
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
  const tokenEmail = String(decoded.email || "").trim().toLowerCase();
  const isApprovedTester = decoded.email_verified === true && approvedEmails.includes(tokenEmail);

  if (isAnonymous || (!isOwner && !isApprovedTester)) {
    throw Object.assign(new Error("Google access is only available to the Axon owner and approved testers."), { status: 403 });
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
function extractGoogleDocText(nodes) {
  let output = "";
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node.paragraph?.elements) {
      for (const element of node.paragraph.elements) output += element.textRun?.content || "";
    }
    if (node.table?.tableRows) {
      for (const row of node.table.tableRows) for (const cell of row.tableCells || []) output += extractGoogleDocText(cell.content || []);
    }
    if (node.tableOfContents?.content) output += extractGoogleDocText(node.tableOfContents.content);
  }
  return output;
}
function findDocumentPlaceholder(text) {
  const value = String(text || "");
  return /\[(?:\s*(?:insert|add|enter|mention|include|describe|year|industry|sector|service(?:\s*\d+)?|product(?:\s*\d+)?|role|website|email(?:\/phone)?|phone|core focus|company details|your\s+[^\]]+)[^\]]*)\]|\b(?:lorem ipsum|TBD|TODO)\b/i.test(value);
}
function validateSheetValues(values) {
  if (!Array.isArray(values) || !values.length || values.length > 500) throw new Error("Provide a non-empty values array with up to 500 rows.");
  return values.map(row => {
    if (!Array.isArray(row) || row.length > 50) throw new Error("Each spreadsheet row must be an array of at most 50 cells.");
    return row.map(cell => String(cell ?? "").slice(0, 5000));
  });
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
  if (action === "google_read_doc") {
    const documentId = requireString(body.documentId, "Document ID", 300);
    const doc = await googleFetch("https://docs.googleapis.com/v1/documents/" + encodeURIComponent(documentId), accessToken);
    return { action, documentId, title: doc.title || "", text: extractGoogleDocText(doc.body?.content || []).slice(0, 30000), url: "https://docs.google.com/document/d/" + documentId + "/edit" };
  }
  if (action === "google_append_doc") {
    requireConfirmed(body);
    const documentId = requireString(body.documentId, "Document ID", 300);
    const text = requireString(body.text, "Text to append", 30000);
    const doc = await googleFetch("https://docs.googleapis.com/v1/documents/" + encodeURIComponent(documentId), accessToken);
    const bodyContent = Array.isArray(doc.body?.content) ? doc.body.content : [];
    const endIndex = Number(bodyContent[bodyContent.length - 1]?.endIndex) || 1;
    const insertText = text.startsWith("\n") ? text : "\n" + text;
    await googleFetch("https://docs.googleapis.com/v1/documents/" + encodeURIComponent(documentId) + ":batchUpdate", accessToken, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ insertText: { location: { index: Math.max(1, endIndex - 1) }, text: insertText } }] })
    });
    return { action, documentId, title: doc.title || "", url: "https://docs.google.com/document/d/" + documentId + "/edit" };
  }
  if (action === "google_replace_doc_text") {
    requireConfirmed(body);
    const documentId = requireString(body.documentId, "Document ID", 300);
    const findText = requireString(body.findText, "Exact text to replace", 10000);
    const replaceText = typeof body.replaceText === "string" ? body.replaceText.slice(0, 10000) : "";
    const doc = await googleFetch("https://docs.googleapis.com/v1/documents/" + encodeURIComponent(documentId), accessToken);
    const existingText = extractGoogleDocText(doc.body?.content || []);
    if (existingText.split(findText).length - 1 !== 1) throw Object.assign(new Error("The exact text must occur once in the document. No change was made."), { status: 409 });
    await googleFetch("https://docs.googleapis.com/v1/documents/" + encodeURIComponent(documentId) + ":batchUpdate", accessToken, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ replaceAllText: { containsText: { text: findText, matchCase: true }, replaceText } }] })
    });
    return { action, documentId, title: doc.title || "", url: "https://docs.google.com/document/d/" + documentId + "/edit", message: "Replaced the one verified occurrence." };
  }
  if (action === "google_create_doc") {
    requireConfirmed(body);
    const title = requireString(body.title, "Document title", 200);
    const text = requireString(body.text, "Document text", 50000);
    if (findDocumentPlaceholder(text)) {
      throw Object.assign(new Error("Document content contains unfinished template placeholders. No Google Doc was created. Rewrite the content completely and replace every placeholder with real information."), { status: 400 });
    }
    if (body.allowShort !== true && text.trim().split(/\s+/).filter(Boolean).length < 40) {
      throw Object.assign(new Error("The document content is too short to be a useful finished document. No Google Doc was created. Write complete, substantive content or honor an explicit request for a short document."), { status: 400 });
    }
    const doc = await googleFetch("https://docs.googleapis.com/v1/documents", accessToken, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
    await googleFetch("https://docs.googleapis.com/v1/documents/" + encodeURIComponent(doc.documentId) + ":batchUpdate", accessToken, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text } }] })
    });
    const savedDoc = await googleFetch("https://docs.googleapis.com/v1/documents/" + encodeURIComponent(doc.documentId), accessToken);
    const savedText = extractGoogleDocText(savedDoc.body?.content || []);
    const expected = text.trim().replace(/\s+/g, " ");
    const actual = savedText.trim().replace(/\s+/g, " ");
    const verified = actual.length >= expected.length * 0.9 && (actual.includes(expected) || expected.includes(actual));
    return {
      action, title, documentId: doc.documentId,
      url: "https://docs.google.com/document/d/" + doc.documentId + "/edit",
      verified,
      wordCount: savedText.trim().split(/\s+/).filter(Boolean).length,
      warnings: verified ? [] : ["Google Docs accepted the write, but reading the document back did not confirm the full content. Inspect this document before claiming completion."]
    };
  }
  if (action === "google_read_sheet") {
    const spreadsheetId = requireString(body.spreadsheetId, "Spreadsheet ID", 300);
    const range = requireString(String(body.range || "A1:Z100"), "Range", 200);
    const data = await googleFetch("https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(spreadsheetId) + "/values/" + encodeURIComponent(range), accessToken);
    return { action, spreadsheetId, range, values: data.values || [], url: "https://docs.google.com/spreadsheets/d/" + spreadsheetId + "/edit" };
  }
  if (action === "google_update_sheet") {
    requireConfirmed(body);
    const spreadsheetId = requireString(body.spreadsheetId, "Spreadsheet ID", 300);
    const range = requireString(body.range, "Range", 200);
    const values = validateSheetValues(body.values);
    const data = await googleFetch("https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(spreadsheetId) + "/values/" + encodeURIComponent(range) + "?valueInputOption=RAW", accessToken, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values })
    });
    return { action, spreadsheetId, range, updatedCells: data.updatedCells || 0, url: "https://docs.google.com/spreadsheets/d/" + spreadsheetId + "/edit" };
  }
  if (action === "google_create_sheet") {
    requireConfirmed(body);
    const title = requireString(body.title, "Spreadsheet title", 200);
    const values = validateSheetValues(body.values);
    const sheet = await googleFetch("https://sheets.googleapis.com/v4/spreadsheets", accessToken, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ properties: { title } })
    });
    await googleFetch("https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(sheet.spreadsheetId) + "/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", accessToken, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values })
    });
    return { action, title, spreadsheetId: sheet.spreadsheetId, url: sheet.spreadsheetUrl };
  }
  if (action === "google_read_form") {
    const formId = requireString(body.formId, "Form ID", 300);
    const form = await googleFetch("https://forms.googleapis.com/v1/forms/" + encodeURIComponent(formId), accessToken);
    return {
      action, formId, title: form.info?.title || "",
      items: (form.items || []).map(item => ({
        itemId: item.itemId, title: item.title || "",
        type: item.questionItem?.question?.choiceQuestion?.type || (item.questionItem ? "QUESTION" : "OTHER"),
        options: (item.questionItem?.question?.choiceQuestion?.options || []).map(option => option.value)
      })),
      editUrl: "https://docs.google.com/forms/d/" + formId + "/edit",
      url: form.responderUri || "https://docs.google.com/forms/d/" + formId + "/edit"
    };
  }
  if (action === "google_add_form_questions") {
    requireConfirmed(body);
    const formId = requireString(body.formId, "Form ID", 300);
    if (!Array.isArray(body.questions) || body.questions.length < 1 || body.questions.length > 100) {
      throw new Error("Provide 1–100 questions to add.");
    }
    const questions = body.questions.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Question " + (index + 1) + " must be an object.");
      }
      const question = requireString(entry.question ?? entry.title, "Question " + (index + 1), 500);
      if (!Array.isArray(entry.options) || entry.options.length < 2 || entry.options.length > 100) {
        throw new Error("Question " + (index + 1) + " needs 2–100 answer options.");
      }
      const options = entry.options.map((value, optionIndex) =>
        requireString(String(value), "Question " + (index + 1) + " option " + (optionIndex + 1), 300)
      );
      if (new Set(options).size !== options.length) {
        throw new Error("Question " + (index + 1) + " has duplicate answer options.");
      }
      return { question, options, required: entry.required !== false };
    });
    const form = await googleFetch("https://forms.googleapis.com/v1/forms/" + encodeURIComponent(formId), accessToken);
    const startIndex = Array.isArray(form.items) ? form.items.length : 0;
    const requests = questions.map((entry, index) => ({
      createItem: {
        item: {
          title: entry.question,
          questionItem: {
            question: {
              required: entry.required,
              choiceQuestion: { type: "RADIO", options: entry.options.map(value => ({ value })) }
            }
          }
        },
        location: { index: startIndex + index }
      }
    }));
    await googleFetch("https://forms.googleapis.com/v1/forms/" + encodeURIComponent(formId) + ":batchUpdate", accessToken, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests })
    });
    const verifiedForm = await googleFetch("https://forms.googleapis.com/v1/forms/" + encodeURIComponent(formId), accessToken);
    const actualItems = Array.isArray(verifiedForm.items) ? verifiedForm.items : [];
    const addedItems = actualItems.slice(startIndex, startIndex + questions.length);
    const verified = addedItems.length === questions.length && questions.every((question, index) => {
      const actual = addedItems[index];
      const actualOptions = actual?.questionItem?.question?.choiceQuestion?.options || [];
      return actual?.title === question.question &&
        actualOptions.length === question.options.length &&
        question.options.every((option, optionIndex) => actualOptions[optionIndex]?.value === option);
    });
    return {
      action, formId, title: verifiedForm.info?.title || form.info?.title || "",
      addedQuestionCount: addedItems.length, totalQuestionCount: actualItems.length, verified,
      ...(verified ? {} : { warning: "Google did not confirm every requested question. Inspect the existing form before retrying to avoid duplicates." }),
      editUrl: "https://docs.google.com/forms/d/" + formId + "/edit",
      url: verifiedForm.responderUri || form.responderUri || "https://docs.google.com/forms/d/" + formId + "/edit"
    };
  }
  if (action === "google_add_form_question") {
    requireConfirmed(body);
    const formId = requireString(body.formId, "Form ID", 300);
    const question = requireString(body.question, "Form question", 500);
    if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 100) throw new Error("A multiple-choice question needs 2–100 options.");
    const options = body.options.map(value => ({ value: requireString(String(value), "Option", 300) }));
    const form = await googleFetch("https://forms.googleapis.com/v1/forms/" + encodeURIComponent(formId), accessToken);
    const index = Array.isArray(form.items) ? form.items.length : 0;
    await googleFetch("https://forms.googleapis.com/v1/forms/" + encodeURIComponent(formId) + ":batchUpdate", accessToken, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ createItem: { item: { title: question, questionItem: { question: { required: Boolean(body.required), choiceQuestion: { type: "RADIO", options } } } }, location: { index } } }] })
    });
    return { action, formId, question, itemCount: index + 1, editUrl: "https://docs.google.com/forms/d/" + formId + "/edit", url: form.responderUri || "https://docs.google.com/forms/d/" + formId + "/edit" };
  }
  if (action === "google_create_form") {
    requireConfirmed(body);
    const title = requireString(body.title, "Form title", 200);

    // Accept a batch of questions, the legacy single-question shape, or an empty
    // form that Axon can populate in later tool calls.
    let requestedQuestions = [];
    if (Array.isArray(body.questions)) {
      requestedQuestions = body.questions;
    } else if (body.question !== undefined || body.options !== undefined) {
      if (body.question === undefined || body.options === undefined) {
        throw new Error("Provide both question and options, or omit both to create an empty form.");
      }
      requestedQuestions = [{
        question: body.question,
        options: body.options,
        correct_answer: body.correct_answer ?? body.correctAnswer,
        required: body.required
      }];
    }
    if (requestedQuestions.length > 100) throw new Error("A form can contain at most 100 questions in one action.");

    const questions = requestedQuestions.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Question " + (index + 1) + " must be an object.");
      }
      const question = requireString(entry.question ?? entry.title, "Question " + (index + 1), 500);
      if (!Array.isArray(entry.options) || entry.options.length < 2 || entry.options.length > 100) {
        throw new Error("Question " + (index + 1) + " needs 2–100 answer options.");
      }
      const optionValues = entry.options.map((value, optionIndex) =>
        requireString(String(value), "Question " + (index + 1) + " option " + (optionIndex + 1), 300)
      );
      if (new Set(optionValues).size !== optionValues.length) {
        throw new Error("Question " + (index + 1) + " has duplicate answer options.");
      }

      const rawCorrect = entry.correct_answer ?? entry.correctAnswer;
      let correctAnswer = null;
      if (rawCorrect !== undefined && rawCorrect !== null && String(rawCorrect).trim() !== "") {
        const candidate = String(rawCorrect).trim();
        if (/^\d+$/.test(candidate) && Number(candidate) >= 1 && Number(candidate) <= optionValues.length) {
          correctAnswer = optionValues[Number(candidate) - 1];
        } else if (optionValues.includes(candidate)) {
          correctAnswer = candidate;
        } else {
          throw new Error("The correct answer for question " + (index + 1) + " must match an option or be its 1-based number.");
        }
      }
      return {
        question,
        options: optionValues,
        correctAnswer,
        required: entry.required !== false
      };
    });

    const form = await googleFetch("https://forms.googleapis.com/v1/forms", accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ info: { title, documentTitle: title } })
    });
    if (!form.formId) throw new Error("Google did not return a form ID, so Axon cannot verify the new form.");

    const editUrl = "https://docs.google.com/forms/d/" + form.formId + "/edit";
    const url = form.responderUri || editUrl;
    const warnings = [];

    const setupRequests = [];
    if (typeof body.description === "string" && body.description.trim()) {
      setupRequests.push({
        updateFormInfo: {
          info: { description: body.description.trim().slice(0, 5000) },
          updateMask: "description"
        }
      });
    }
    const isQuiz = body.quiz === true || questions.some(question => question.correctAnswer !== null);
    if (isQuiz) {
      setupRequests.push({
        updateSettings: {
          settings: { quizSettings: { isQuiz: true } },
          updateMask: "quizSettings.isQuiz"
        }
      });
    }

    if (setupRequests.length) {
      try {
        await googleFetch("https://forms.googleapis.com/v1/forms/" + encodeURIComponent(form.formId) + ":batchUpdate", accessToken, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requests: setupRequests })
        });
      } catch (error) {
        warnings.push("Form created, but description/quiz setup failed: " + error.message);
      }
    }

    if (questions.length) {
      const requests = questions.map((question, index) => {
        const questionData = {
          required: question.required,
          choiceQuestion: {
            type: "RADIO",
            options: question.options.map(value => ({ value }))
          }
        };
        if (isQuiz && question.correctAnswer !== null) {
          questionData.grading = {
            pointValue: 1,
            correctAnswers: { answers: [{ value: question.correctAnswer }] }
          };
        }
        return {
          createItem: {
            item: { title: question.question, questionItem: { question: questionData } },
            location: { index }
          }
        };
      });
      try {
        await googleFetch("https://forms.googleapis.com/v1/forms/" + encodeURIComponent(form.formId) + ":batchUpdate", accessToken, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requests })
        });
      } catch (error) {
        warnings.push("The form exists, but adding its questions failed: " + error.message);
      }
    }

    let verifiedForm = null;
    try {
      verifiedForm = await googleFetch("https://forms.googleapis.com/v1/forms/" + encodeURIComponent(form.formId), accessToken);
    } catch (error) {
      warnings.push("The form was created, but Google read-back verification failed: " + error.message);
    }

    const actualItems = Array.isArray(verifiedForm?.items) ? verifiedForm.items : [];
    const questionsVerified = Boolean(verifiedForm) &&
      actualItems.length === questions.length &&
      questions.every((question, index) => {
        const actual = actualItems[index];
        const actualOptions = actual?.questionItem?.question?.choiceQuestion?.options || [];
        const optionsMatch = actualOptions.length === question.options.length &&
          question.options.every((option, optionIndex) => actualOptions[optionIndex]?.value === option);
        const correctAnswerMatch = !question.correctAnswer ||
          (actual?.questionItem?.question?.grading?.correctAnswers?.answers || [])
            .some(answer => answer.value === question.correctAnswer);
        return actual?.title === question.question && optionsMatch && correctAnswerMatch;
      });

    if (verifiedForm && !questionsVerified) {
      warnings.push("Google returned the form, but its saved question count/options/answers did not match the request.");
    }

    return {
      action,
      title: verifiedForm?.info?.title || title,
      formId: form.formId,
      questionCount: actualItems.length,
      requestedQuestionCount: questions.length,
      verified: questionsVerified && warnings.length === 0,
      ...(warnings.length ? { warnings } : {}),
      url: verifiedForm?.responderUri || url,
      editUrl
    };
  }
  if (action === "calendar_list_events") {
    const now = Date.now();
    const timeMin = String(body.timeMin || new Date(now).toISOString());
    const timeMax = String(body.timeMax || new Date(now + 30 * 86400000).toISOString());
    const params = new URLSearchParams({ timeMin, timeMax, maxResults: "50", singleEvents: "true", orderBy: "startTime" });
    const data = await googleFetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?" + params.toString(), accessToken);
    return { action, events: (data.items || []).map(event => ({ id: event.id, summary: event.summary || "", start: event.start?.dateTime || event.start?.date || "", end: event.end?.dateTime || event.end?.date || "", url: event.htmlLink || "" })) };
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("Recipient email is invalid.");
    const raw = "To: " + to + "\r\nSubject: " + subject + "\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n" + text;
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

const DEFAULT_ALLOWED_REPOS = [
    "CoolerStarfish0/my-ai",
    "CoolerStarfish0/5158-ai-backend"
];

function jsonError(res, status, error) {
    return res.status(status).json({ error });
}

export default async function handler(req, res) {
    // Share this route with Google OAuth/actions to stay within the Vercel Hobby function-count limit.
    if (req.query?.mode === "google") return (await import("../lib/google-agent.js")).default(req, res);
    const allowedOrigin = "https://coolerstarfish0.github.io";
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return jsonError(res, 405, "Method not allowed");
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) return jsonError(res, 403, "Origin not allowed");

    try {
        const { getApps, initializeApp, cert } = await import("firebase-admin/app");
        const { getAuth } = await import("firebase-admin/auth");
        if (getApps().length === 0) {
            if (!process.env.FIREBASE_SERVICE_ACCOUNT) return jsonError(res, 500, "FIREBASE_SERVICE_ACCOUNT is missing");
            initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
        }

        const authorization = req.headers.authorization || "";
        if (!authorization.startsWith("Bearer ")) return jsonError(res, 401, "Authentication required");
        let decoded;
        try { decoded = await getAuth().verifyIdToken(authorization.slice(7).trim()); }
        catch { return jsonError(res, 401, "Invalid or expired login session"); }
        if (!process.env.OWNER_UID || decoded.uid !== process.env.OWNER_UID || decoded.firebase?.sign_in_provider === "anonymous") {
            return jsonError(res, 403, "Owner access required");
        }

        const token = process.env.GITHUB_TOKEN;
        if (!token) return jsonError(res, 503, "GitHub integration is not configured yet. Add a fine-grained GITHUB_TOKEN secret to the backend deployment.");
        const body = req.body || {};
        const action = String(body.action || "");
        const repo = String(body.repo || "CoolerStarfish0/my-ai");
        const allowedRepos = (process.env.GITHUB_ALLOWED_REPOS || DEFAULT_ALLOWED_REPOS.join(","))
            .split(",").map(value => value.trim()).filter(Boolean);
        if (!allowedRepos.includes(repo) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
            return jsonError(res, 403, "This repository is not on Axon's allowed list.");
        }

        const githubFetch = async (url, options = {}) => {
            const response = await fetch(url, {
                ...options,
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: "Bearer " + token,
                    "X-GitHub-Api-Version": "2022-11-28",
                    ...(options.headers || {})
                }
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                const message = typeof data.message === "string" ? data.message : "GitHub request failed";
                throw new Error("GitHub API " + response.status + ": " + message);
            }
            return data;
        };
        const safePath = value => {
            const path = String(value || "").replace(/^\/+/, "");
            if (!path || path.split("/").some(part => !part || part === "." || part === "..") || path.includes("\\") || path.length > 240) {
                throw new Error("Invalid repository path.");
            }
            if (/^\.github\/workflows\//i.test(path) || /(^|\/)(\.env(?:\.|$)|id_rsa|.*\.pem$)/i.test(path)) {
                throw new Error("Axon cannot edit workflow files or likely secret files through this tool.");
            }
            return path;
        };
        const apiBase = "https://api.github.com/repos/" + repo;

        if (action === "list_files") {
            const path = body.path ? safePath(body.path) : "";
            const url = apiBase + "/contents" + (path ? "/" + path.split("/").map(encodeURIComponent).join("/") : "");
            const data = await githubFetch(url);
            const entries = Array.isArray(data) ? data : [data];
            return res.status(200).json({ action, repo, path, entries: entries.slice(0, 100).map(entry => ({
                name: entry.name, path: entry.path, type: entry.type, size: entry.size, sha: entry.sha
            })) });
        }

        if (action === "read_file") {
            const path = safePath(body.path);
            const data = await githubFetch(apiBase + "/contents/" + path.split("/").map(encodeURIComponent).join("/"));
            if (Array.isArray(data) || data.type !== "file") return jsonError(res, 400, "That path is not a file.");
            if (data.size > 180000) return jsonError(res, 413, "That file is too large to read in one request.");
            const content = Buffer.from(String(data.content || "").replace(/\n/g, ""), "base64").toString("utf8");
            return res.status(200).json({ action, repo, path, sha: data.sha, content: content.slice(0, 180000) });
        }

        if (action === "search_code") {
            const query = String(body.query || "").trim();
            if (!query || query.length > 160) return jsonError(res, 400, "Provide a search query up to 160 characters.");
            const encoded = encodeURIComponent(query + " repo:" + repo);
            const data = await githubFetch("https://api.github.com/search/code?q=" + encoded + "&per_page=10", {
                headers: { Accept: "application/vnd.github.text-match+json" }
            });
            return res.status(200).json({ action, repo, totalCount: data.total_count || 0, results: (data.items || []).slice(0, 10).map(item => ({
                path: item.path,
                url: item.html_url,
                name: item.name,
                snippets: (item.text_matches || []).slice(0, 3).map(match => String(match.fragment || "").slice(0, 1200))
            })) });
        }

        if (action === "patch_file") {
            if (body.confirmed !== true) return jsonError(res, 400, "Explicit confirmation is required before changing a repository.");
            const path = safePath(body.path);
            const expectedSha = String(body.sha || "");
            const findText = body.find;
            const replaceText = body.replace;
            const message = String(body.message || "").trim().slice(0, 180);
            if (!/^[0-9a-f]{40}$/i.test(expectedSha)) return jsonError(res, 400, "A current file SHA is required to patch a file.");
            if (typeof findText !== "string" || !findText || findText.length > 20000) return jsonError(res, 400, "The exact text to find must be 1–20,000 characters.");
            if (typeof replaceText !== "string" || replaceText.length > 20000) return jsonError(res, 400, "Replacement text must be under 20,000 characters.");
            if (!message) return jsonError(res, 400, "A commit message is required.");
            const fileUrl = apiBase + "/contents/" + path.split("/").map(encodeURIComponent).join("/");
            const current = await githubFetch(fileUrl);
            if (Array.isArray(current) || current.type !== "file") return jsonError(res, 400, "That path is not a file.");
            if (current.sha !== expectedSha) return jsonError(res, 409, "The file changed since Axon read it. Read the latest version before retrying.");
            if (current.size > 180000) return jsonError(res, 413, "That file is too large to patch safely.");
            const currentText = Buffer.from(String(current.content || "").replace(/\n/g, ""), "base64").toString("utf8");
            const occurrences = currentText.split(findText).length - 1;
            if (occurrences !== 1) return jsonError(res, 409, "The exact text must occur once. No change was made; inspect the file and choose a more specific patch.");
            const nextText = currentText.replace(findText, replaceText);
            if (Buffer.byteLength(nextText, "utf8") > 180000) return jsonError(res, 413, "Patched file exceeds the safe size limit.");
            const committed = await githubFetch(fileUrl, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message,
                    sha: current.sha,
                    content: Buffer.from(nextText, "utf8").toString("base64")
                })
            });
            return res.status(200).json({ action, repo, path, commitSha: committed.commit?.sha || null, url: committed.content?.html_url || null });
        }

        if (action === "create_file" || action === "update_file") {
            if (body.confirmed !== true) return jsonError(res, 400, "Explicit confirmation is required before changing a repository.");
            const path = safePath(body.path);
            const content = body.content;
            const message = String(body.message || "").trim().slice(0, 180);
            if (typeof content !== "string" || content.length > 180000) return jsonError(res, 400, "File content must be text under 180 KB.");
            if (!message) return jsonError(res, 400, "A commit message is required.");
            if (action === "update_file" && !/^[0-9a-f]{40}$/i.test(String(body.sha || ""))) return jsonError(res, 400, "A current file SHA is required to update a file.");
            const payload = { message, content: Buffer.from(content, "utf8").toString("base64") };
            if (action === "update_file") payload.sha = String(body.sha);
            const data = await githubFetch(apiBase + "/contents/" + path.split("/").map(encodeURIComponent).join("/"), {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            return res.status(200).json({ action, repo, path, commitSha: data.commit?.sha || null, url: data.content?.html_url || null });
        }

        return jsonError(res, 400, "Unsupported GitHub action.");
    } catch (error) {
        console.error("Axon GitHub agent error:", error);
        return jsonError(res, 500, error.message || "GitHub tool failed.");
    }
}

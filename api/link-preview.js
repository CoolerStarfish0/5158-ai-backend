import dns from "node:dns/promises";
import net from "node:net";

const ALLOWED_ORIGIN = "https://coolerstarfish0.github.io";
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const MAX_HTML_BYTES = 1024 * 1024;

function isPrivateIPv4(ip) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
        (p[0] === 169 && p[1] === 254) ||
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
        (p[0] === 192 && p[1] === 168) ||
        (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
        p[0] >= 224;
}

async function assertPublicUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error("Invalid URL."); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP and HTTPS links are supported.");
    if (url.username || url.password) throw new Error("URLs containing credentials are not supported.");
    if (url.port && !["80", "443"].includes(url.port)) throw new Error("This link uses an unsupported port.");
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
        throw new Error("Private network addresses cannot be previewed.");
    }
    const family = net.isIP(host);
    if (family === 4 && isPrivateIPv4(host)) throw new Error("Private network addresses cannot be previewed.");
    if (family === 6) throw new Error("IPv6 literal addresses cannot be previewed.");
    if (!family) {
        const records = await dns.lookup(host, { all: true, verbatim: true });
        if (!records.length || records.some(record => record.family !== 4 || isPrivateIPv4(record.address))) {
            throw new Error("This host does not resolve exclusively to public addresses.");
        }
    }
    return url;
}

function decodeEntities(value) {
    return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function getMeta(html, names) {
    for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const patterns = [
            new RegExp("<meta[^>]+(?:property|name)=[\"']" + escaped + "[\"'][^>]+content=[\"']([^\"']*)[\"'][^>]*>", "i"),
            new RegExp("<meta[^>]+content=[\"']([^\"']*)[\"'][^>]+(?:property|name)=[\"']" + escaped + "[\"'][^>]*>", "i")
        ];
        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match) return decodeEntities(match[1].trim());
        }
    }
    return "";
}

function plainText(value) {
    return decodeEntities(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim().slice(0, 300);
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=1200");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed." });

    try {
        const raw = typeof req.query?.url === "string" ? req.query.url : "";
        if (!raw || raw.length > 2048) return res.status(400).json({ error: "Provide a valid URL." });
        const initial = await assertPublicUrl(raw);
        const cacheKey = initial.href;
        const cached = CACHE.get(cacheKey);
        if (cached && cached.expires > Date.now()) return res.status(200).json(cached.data);

        let current = initial;
        let response;
        for (let hop = 0; hop <= 3; hop++) {
            await assertPublicUrl(current.href);
            response = await fetch(current.href, {
                redirect: "manual",
                headers: { "User-Agent": "AxonLinkPreview/1.0 (+https://coolerstarfish0.github.io)", "Accept": "text/html,application/xhtml+xml" },
                signal: AbortSignal.timeout(7000)
            });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get("location");
                if (!location || hop === 3) throw new Error("Too many redirects.");
                current = new URL(location, current);
                continue;
            }
            break;
        }
        if (!response?.ok) throw new Error("The website did not provide a preview.");
        const type = response.headers.get("content-type") || "";
        if (!/text\/html|application\/xhtml\+xml/i.test(type)) throw new Error("This link does not point to a webpage.");
        const reader = response.body?.getReader();
        if (!reader) throw new Error("The webpage could not be read.");
        const chunks = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_HTML_BYTES) { await reader.cancel(); throw new Error("The webpage is too large to preview."); }
            chunks.push(value);
        }
        const html = new TextDecoder().decode(Buffer.concat(chunks));
        const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = (getMeta(html, ["og:title", "twitter:title"]) || plainText(titleTag?.[1] || "") || current.hostname).slice(0, 180);
        const description = (getMeta(html, ["og:description", "twitter:description", "description"]) || "").slice(0, 300);
        let image = getMeta(html, ["og:image", "twitter:image"]);
        if (image) {
            try {
                const imageUrl = new URL(image, current);
                if (["https:", "http:"].includes(imageUrl.protocol)) image = imageUrl.href;
                else image = "";
            } catch { image = ""; }
        }
        const data = { url: initial.href, finalUrl: current.href, title, description, image, siteName: getMeta(html, ["og:site_name"]) || current.hostname };
        CACHE.set(cacheKey, { data, expires: Date.now() + CACHE_TTL });
        return res.status(200).json(data);
    } catch (error) {
        return res.status(400).json({ error: error.message || "Preview unavailable." });
    }
}

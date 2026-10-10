export default async function handler(req, res) {
    // ==========================================
    // CORS
    // ==========================================

    res.setHeader(
        "Access-Control-Allow-Origin",
        "https://coolerstarfish0.github.io"
    );

    res.setHeader(
        "Access-Control-Allow-Methods",
        "POST, OPTIONS"
    );

    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
    );

    // ==========================================
    // PREFLIGHT
    // ==========================================

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    // ==========================================
    // METHOD CHECK
    // ==========================================

    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed"
        });
    }

    try {
        // ==========================================
        // FIREBASE AUTH
        // ==========================================

        const authorization =
            req.headers.authorization || "";

        if (!authorization.startsWith("Bearer ")) {
            return res.status(401).json({
                error: "Authentication required"
            });
        }

        const idToken =
            authorization.substring(7).trim();

        if (!idToken) {
            return res.status(401).json({
                error: "Invalid authentication token"
            });
        }

        // ==========================================
        // FIREBASE ADMIN
        // ==========================================

        const {
            getApps,
            initializeApp,
            cert
        } = await import("firebase-admin/app");

        const {
            getAuth
        } = await import("firebase-admin/auth");

        if (getApps().length === 0) {
            if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
                return res.status(500).json({
                    error:
                        "FIREBASE_SERVICE_ACCOUNT is missing"
                });
            }

            const serviceAccount =
                JSON.parse(
                    process.env.FIREBASE_SERVICE_ACCOUNT
                );

            initializeApp({
                credential: cert(serviceAccount)
            });
        }

        const firebaseAuth = getAuth();

        // ==========================================
        // VERIFY USER
        // ==========================================

        try {
            await firebaseAuth.verifyIdToken(idToken);
        } catch (error) {
            console.error(
                "Firebase token verification failed:",
                error
            );

            return res.status(401).json({
                error:
                    "Invalid or expired login session"
            });
        }

        const { enforceWorkRank } = await import("../../lib/work-access.js");
        if (!await enforceWorkRank(req, res)) return;

        // ==========================================
        // LOCAL AI SETTINGS
        // ==========================================

        const localAIUrl =
            process.env.LOCAL_AI_URL;

        const localAISecret =
            process.env.LOCAL_AI_SECRET;

        if (!localAIUrl || !localAISecret) {
            console.error(
                "Missing LOCAL_AI_URL or LOCAL_AI_SECRET"
            );

            return res.status(500).json({
                error:
                    "Local AI environment variables are missing"
            });
        }

        // ==========================================
        // VISION REQUEST
        // ==========================================

        const requestedPrompt =
            typeof req.body?.prompt === "string" &&
            req.body.prompt.trim()
                ? req.body.prompt.trim()
                : "Describe what is currently visible on the screen. Focus on important visual information.";

        const response = await fetch(
            `${localAIUrl}/api/work/vision`,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json",

                    "Authorization":
                        `Bearer ${localAISecret}`
                },

                body: JSON.stringify({
                    prompt: requestedPrompt
                })
            }
        );

        // ==========================================
        // READ BRIDGE RESPONSE
        // ==========================================

        let data;

        try {
            data = await response.json();
        } catch (error) {
            console.error(
                "Invalid response from local vision bridge:",
                error
            );

            return res.status(502).json({
                error:
                    "Vision bridge returned an invalid response"
            });
        }

        // ==========================================
        // BRIDGE ERROR
        // ==========================================

        if (!response.ok) {
            console.error(
                "Vision bridge request failed:",
                data
            );

            return res.status(502).json({
                error:
                    data.error ||
                    "Vision request failed",

                details:
                    data.details || null
            });
        }

        // ==========================================
        // SUCCESS
        // ==========================================

        return res.status(200).json({
            success: true,

            answer:
                typeof data.answer === "string"
                    ? data.answer.trim()
                    : "",

            model:
                typeof data.model === "string"
                    ? data.model
                    : "qwen3-vl:8b"
        });

    } catch (error) {
        console.error(
            "Work Mode vision error:",
            error
        );

        return res.status(500).json({
            error:
                "Failed to connect to vision system",

            details:
                error.message
        });
    }
}

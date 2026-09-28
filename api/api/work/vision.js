// ==========================================
// WORK MODE VISION
// ==========================================

export async function workVisionHandler(req, res) {
    // CORS
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

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed"
        });
    }

    try {
        // Firebase authentication
        const authorization =
            req.headers.authorization || "";

        if (!authorization.startsWith("Bearer ")) {
            return res.status(401).json({
                error: "Authentication required"
            });
        }

        const idToken =
            authorization.substring(7).trim();

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
                    error: "FIREBASE_SERVICE_ACCOUNT is missing"
                });
            }

            initializeApp({
                credential: cert(
                    JSON.parse(
                        process.env.FIREBASE_SERVICE_ACCOUNT
                    )
                )
            });
        }

        const firebaseAuth = getAuth();

        try {
            await firebaseAuth.verifyIdToken(idToken);
        } catch {
            return res.status(401).json({
                error: "Invalid or expired login session"
            });
        }

        // Local bridge settings
        const localAIUrl =
            process.env.LOCAL_AI_URL;

        const localAISecret =
            process.env.LOCAL_AI_SECRET;

        if (!localAIUrl || !localAISecret) {
            return res.status(500).json({
                error:
                    "Local AI environment variables are missing"
            });
        }

        // Ask local bridge for a screenshot analysis
        const response = await fetch(
            `${localAIUrl}/api/work/vision`,
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json",
                    "Authorization":
                        `Bearer ${localAISecret}`
                },

                body: JSON.stringify({
                    prompt:
                        req.body?.prompt ||
                        "Describe what is currently visible on the screen. Focus on important visual information."
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            return res.status(502).json({
                error:
                    data.error ||
                    "Vision request failed",

                details:
                    data.details || null
            });
        }

        return res.status(200).json({
            success: true,
            answer: data.answer || "",
            model: data.model || "qwen3-vl:8b"
        });

    } catch (error) {
        console.error(
            "Work Mode vision error:",
            error
        );

        return res.status(500).json({
            error: "Failed to connect to vision system",
            details: error.message
        });
    }
}

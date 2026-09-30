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
        // START LOCAL WORK MODE
        // ==========================================

        const response = await fetch(
            `${localAIUrl}/api/work/start`,
            {
                method: "POST",

                headers: {
                    "Authorization":
                        `Bearer ${localAISecret}`
                }
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
                "Invalid response from local Work Mode bridge:",
                error
            );

            return res.status(502).json({
                error:
                    "Work Mode bridge returned an invalid response"
            });
        }

        // ==========================================
        // BRIDGE ERROR
        // ==========================================

        if (!response.ok) {
            console.error(
                "Work Mode start failed:",
                data
            );

            return res.status(502).json({
                error:
                    data.error ||
                    "Failed to start Work Mode",

                details:
                    data.details || null
            });
        }

        // ==========================================
        // SUCCESS
        // ==========================================

        return res.status(200).json({
            success: true,
            workMode: true
        });

    } catch (error) {
        console.error(
            "Work Mode start error:",
            error
        );

        return res.status(500).json({
            error:
                "Failed to connect to Work Mode",

            details:
                error.message
        });
    }
}

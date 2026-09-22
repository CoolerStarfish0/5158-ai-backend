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
        "Content-Type"
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
        // REQUEST BODY
        // ==========================================

        const {
            prompt,
            system
        } = req.body || {};

        if (
            typeof prompt !== "string" ||
            prompt.trim() === ""
        ) {
            return res.status(400).json({
                error: "Missing prompt"
            });
        }

        if (
            system !== undefined &&
            typeof system !== "string"
        ) {
            return res.status(400).json({
                error: "Invalid system prompt"
            });
        }

        // ==========================================
        // ENVIRONMENT VARIABLES
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
        // SEND TO LOCAL AXON
        // ==========================================

        const controller =
            new AbortController();

        // Prevent a request from hanging forever.
        const timeout =
            setTimeout(() => {
                controller.abort();
            }, 120000);

        let response;

        try {
            response = await fetch(
                `${localAIUrl}/api/chat`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",

                        "Authorization":
                            `Bearer ${localAISecret}`
                    },

                    body: JSON.stringify({
                        prompt: prompt.trim(),

                        system:
                            typeof system === "string"
                                ? system
                                : ""
                    }),

                    signal:
                        controller.signal
                }
            );
        } finally {
            clearTimeout(timeout);
        }

        // ==========================================
        // READ LOCAL AI RESPONSE
        // ==========================================

        let data;

        try {
            data = await response.json();
        } catch (error) {
            console.error(
                "Invalid response from local AI:",
                error
            );

            return res.status(502).json({
                error:
                    "Local AI returned an invalid response"
            });
        }

        // ==========================================
        // LOCAL AI ERROR
        // ==========================================

        if (!response.ok) {
            console.error(
                "Local AI request failed:",
                data
            );

            return res.status(502).json({
                error:
                    data.error ||
                    "Local AI request failed",

                details:
                    data.details || null
            });
        }

        // ==========================================
        // VALIDATE ANSWER
        // ==========================================

        if (
            !data ||
            typeof data.answer !== "string" ||
            data.answer.trim() === ""
        ) {
            return res.status(502).json({
                error:
                    "Local AI returned no answer"
            });
        }

        // ==========================================
        // SUCCESS
        // ==========================================

        return res.status(200).json({
            answer: data.answer.trim(),

            model:
                typeof data.model === "string"
                    ? data.model
                    : "unknown",

            source: "local"
        });

    } catch (error) {
        console.error(
            "Local AI error:",
            error
        );

        if (error.name === "AbortError") {
            return res.status(504).json({
                error:
                    "Local AI request timed out"
            });
        }

        return res.status(500).json({
            error:
                "Failed to connect to local AI",

            details:
                error.message
        });
    }
}

export default async function handler(req, res) {
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
        "Authorization, Content-Type"
    );

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed"
        });
    }

    try {
        const { enforceWorkRank } = await import("../../../lib/work-access.js");
        if (!await enforceWorkRank(req, res)) return;

        const authHeader =
            req.headers.authorization || "";

        if (!authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                error: "Missing authentication."
            });
        }

        const firebaseToken =
            authHeader.substring(7);

        if (!firebaseToken) {
            return res.status(401).json({
                error: "Missing authentication token."
            });
        }

        const localAIUrl =
            process.env.LOCAL_AI_URL;

        const localAISecret =
            process.env.LOCAL_AI_SECRET;

        if (!localAIUrl) {
            return res.status(500).json({
                error: "LOCAL_AI_URL is not configured."
            });
        }

        if (!localAISecret) {
            return res.status(500).json({
                error: "LOCAL_AI_SECRET is not configured."
            });
        }

        const { text } =
            req.body || {};

        if (
            typeof text !== "string" ||
            text.length > 5000
        ) {
            return res.status(400).json({
                error:
                    "Invalid text. Text must be a string of 5000 characters or fewer."
            });
        }

        const response =
            await fetch(
                `${localAIUrl}/api/work/keyboard/type`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",

                        "Authorization":
                            `Bearer ${localAISecret}`,

                        "X-Firebase-Token":
                            firebaseToken
                    },

                    body: JSON.stringify({
                        text
                    })
                }
            );

        const responseText =
            await response.text();

        let data;

        try {
            data =
                JSON.parse(responseText);
        } catch {
            data = {
                raw: responseText
            };
        }

        if (!response.ok) {
            return res.status(
                response.status
            ).json({
                error:
                    data.error ||
                    "Local keyboard request failed."
            });
        }

        return res.status(200).json(data);

    } catch (error) {
        console.error(
            "keyboard/type function error:",
            error
        );

        return res.status(500).json({
            error:
                error.message ||
                "Keyboard typing function failed."
        });
    }
}

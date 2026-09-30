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

        const { x, y } =
            req.body || {};

        if (
            typeof x !== "number" ||
            typeof y !== "number" ||
            !Number.isFinite(x) ||
            !Number.isFinite(y)
        ) {
            return res.status(400).json({
                error: "Invalid mouse coordinates."
            });
        }

        const response =
            await fetch(
                `${localAIUrl}/api/work/mouse/move`,
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
                        x,
                        y
                    })
                }
            );

        const text =
            await response.text();

        let data;

        try {
            data =
                JSON.parse(text);
        } catch {
            data = {
                raw: text
            };
        }

        if (!response.ok) {
            return res.status(
                response.status
            ).json({
                error:
                    data.error ||
                    "Local mouse-move request failed."
            });
        }

        return res.status(200).json(data);

    } catch (error) {

        console.error(
            "mouse/move function error:",
            error
        );

        return res.status(500).json({
            error:
                error.message ||
                "Mouse-move function failed."
        });
    }
}

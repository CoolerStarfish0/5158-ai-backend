export default async function handler(req, res) {
    // CORS
    res.setHeader(
        "Access-Control-Allow-Origin",
        "https://coolerstarfish0.github.io"
    );

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, OPTIONS"
    );

    res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type"
    );

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    if (req.method !== "GET") {
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

        const idToken =
            authHeader.substring(7);

        if (!idToken) {
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

        /*
         * Forward the Firebase token and local secret
         * to the local bridge.
         *
         * The local bridge is responsible for verifying
         * the secret and whether Work Mode is currently
         * enabled.
         */

        const response =
            await fetch(
                `${localAIUrl}/api/work/screen-size`,
                {
                    method: "GET",

                    headers: {
                        "Authorization":
                            `Bearer ${localAISecret}`,

                        "X-Firebase-Token":
                            idToken
                    }
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
                    "Local screen-size request failed."
            });
        }

        return res.status(200).json(data);

    } catch (error) {

        console.error(
            "screen-size function error:",
            error
        );

        return res.status(500).json({
            error:
                error.message ||
                "Screen-size function failed."
        });
    }
}

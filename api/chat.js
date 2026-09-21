export default async function handler(req, res) {
    // Allow the frontend to call Vercel
    res.setHeader("Access-Control-Allow-Origin", "https://coolerstarfish0.github.io");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed"
        });
    }

    try {
        const { prompt, system } = req.body || {};

        if (!prompt) {
            return res.status(400).json({
                error: "Missing prompt"
            });
        }

        const localAIUrl = process.env.LOCAL_AI_URL;
        const localAISecret = process.env.LOCAL_AI_SECRET;

        if (!localAIUrl || !localAISecret) {
            return res.status(500).json({
                error: "Local AI environment variables are missing"
            });
        }

        const response = await fetch(`${localAIUrl}/api/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${localAISecret}`
            },
            body: JSON.stringify({
                prompt,
                system: system || ""
            })
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({
                error: data.error || "Local AI request failed",
                details: data.details || null
            });
        }

        return res.status(200).json({
            answer: data.answer,
            model: data.model,
            source: "local"
        });

    } catch (error) {
        console.error("Local AI error:", error);

        return res.status(500).json({
            error: "Failed to connect to local AI",
            details: error.message
        });
    }
}

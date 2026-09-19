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
        "Content-Type"
    );

    // Handle browser CORS preflight
    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed"
        });
    }

    try {
        const { message, memories = [] } = req.body;

        if (!message) {
            return res.status(400).json({
                error: "No message provided"
            });
        }

        // Handle creator questions directly
        const lowerMessage = message.toLowerCase();

        if (
            lowerMessage.includes("who is your creator") ||
            lowerMessage.includes("who is your coder") ||
            lowerMessage.includes("who made you") ||
            lowerMessage.includes("who created you")
        ) {
            return res.status(200).json({
                answer: "CoolerStarfish0"
            });
        }

        if (
            lowerMessage.includes("who is he") ||
            lowerMessage.includes("who is coolerstarfish0") ||
            lowerMessage.includes("tell me about him") ||
            lowerMessage.includes("more about him")
        ) {
            return res.status(200).json({
                answer: "He is **slick, handsome, drippy, sigma, skibidi, mewing, motion-blessed, locked in, valid, absolutely drowning in rizz, Ohio-certified, alpha, cooked to perfection, aura-maxxing, gigachad, glazed, ice-cold, peak, and completely based.**"
            });
        }

        const memoryText = memories.length
            ? `

Relevant information from the user's personal notebook:
${memories.map(m => "- " + m).join("\n")}`
            : "";

        const prompt = `You are a helpful personal AI assistant.

The user said:
${message}

${memoryText}

Use the notebook information when relevant. Answer naturally and directly.`;

        const response = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=" +
            process.env.GEMINI_API_KEY,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    contents: [
                        {
                            parts: [
                                {
                                    text: prompt
                                }
                            ]
                        }
                    ]
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            console.error("Gemini error:", data);

            return res.status(response.status).json({
                error: "Gemini request failed"
            });
        }

        const answer =
            data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!answer) {
            return res.status(500).json({
                error: "Gemini returned no answer"
            });
        }

        return res.status(200).json({
            answer: answer
        });

    } catch (error) {
        console.error("Server error:", error);

        return res.status(500).json({
            error: "Server error"
        });
    }
}

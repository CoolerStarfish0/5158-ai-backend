export default async function handler(req, res) {
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
        const { message, memories = [] } = req.body;

        if (!message) {
            return res.status(400).json({
                error: "No message provided"
            });
        }

        const memoryText = memories.length
            ? `\n\nRelevant information from the user's personal notebook:\n${memories.map(m => "- " + m).join("\n")}`
            : "";

        const prompt = `You are a helpful personal AI assistant.

The user said:
${message}

${memoryText}

Use the notebook information when relevant. Answer naturally and directly.`;

        const response = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
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
            console.error(data);

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
        console.error(error);

        return res.status(500).json({
            error: "Server error"
        });
    }
}

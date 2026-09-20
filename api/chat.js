export default async function handler(req, res) {
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
        "Content-Type"
    );

    // Browser CORS preflight
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

        if (!message || typeof message !== "string") {
            return res.status(400).json({
                error: "No message provided"
            });
        }

        if (!process.env.OPENROUTER_API_KEY) {
            return res.status(500).json({
                error: "OpenRouter API key is not configured"
            });
        }

        // Turn learned knowledge into the AI's notebook.
        const knowledgeText = memories.length
            ? memories
                .map((memory, index) => `${index + 1}. ${memory}`)
                .join("\n")
            : "NO KNOWLEDGE HAS BEEN TAUGHT YET.";

        const prompt = `
You are 5158, a learning AI.

Your factual knowledge is LIMITED to the information contained
in the "TAUGHT KNOWLEDGE" section below.

You can understand English, understand questions, reason about
information you have been given, and have natural conversations.

However, you MUST NOT use your pretrained/world knowledge to
provide factual information that is not contained in the taught
knowledge.

TAUGHT KNOWLEDGE:
${knowledgeText}

USER MESSAGE:
${message}

RULES:

1. Use ONLY the taught knowledge for factual information.

2. You may use normal language understanding and reasoning to
understand what the user is asking.

3. You may combine multiple pieces of taught knowledge when that
allows you to answer the question.

4. If the answer cannot be determined from the taught knowledge,
say that you don't know yet.

5. Do NOT fill missing information with information you already
knew before this conversation.

6. Do NOT pretend to know something that has not been taught.

7. If the user is teaching you something rather than asking a
question, acknowledge it naturally.

8. Keep responses natural and conversational.

9. If the user asks "what do you know?", describe only information
contained in the taught knowledge.

10. Your ability to understand English is separate from your factual
knowledge.

Answer the user's message now.
`;

        // OpenRouter fallback models
const models = [
    "qwen/qwen3.8-27b:free",
    "z-ai/glm-5.2:free",
    "google/gemma-4-26b-a4b-it:free",
    "google/gemma-4-31b-it:free"
];
        let lastError = null;

        for (const model of models) {
            try {
                const response = await fetch(
                    "https://openrouter.ai/api/v1/chat/completions",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization":
                                `Bearer ${process.env.OPENROUTER_API_KEY}`,
                            "HTTP-Referer":
                                "https://coolerstarfish0.github.io/my-ai/",
                            "X-Title": "5158 AI"
                        },
                        body: JSON.stringify({
                            model: model,
                            messages: [
                                {
                                    role: "user",
                                    content: prompt
                                }
                            ]
                        })
                    }
                );

                const data = await response.json();

                if (!response.ok) {
                    console.error(
                        `OpenRouter model ${model} failed:`,
                        data
                    );

                    lastError = data;
                    continue;
                }

                const answer =
                    data.choices?.[0]?.message?.content;

                if (!answer) {
                    lastError = {
                        error: "Model returned no answer",
                        model: model
                    };
                    continue;
                }

                return res.status(200).json({
                    answer: answer,
                    model: model
                });

            } catch (error) {
                console.error(
                    `Error using model ${model}:`,
                    error
                );

                lastError = {
                    error: error.message,
                    model: model
                };

                continue;
            }
        }

        console.error(
            "All OpenRouter models failed:",
            lastError
        );

return res.status(503).json({
    error: "All OpenRouter models failed",
    details: lastError,
    message: lastError?.error?.message || lastError?.message || "Unknown OpenRouter error"
});

    } catch (error) {
        console.error("Server error:", error);

        return res.status(500).json({
            error: "Server error",
            details: error.message
        });
    }
}

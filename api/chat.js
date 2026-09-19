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

        if (!message || typeof message !== "string") {
            return res.status(400).json({
                error: "No message provided"
            });
        }

        // Turn the AI's learned knowledge into a controlled notebook.
        const knowledgeText = memories.length
            ? memories
                .map((memory, index) => `${index + 1}. ${memory}`)
                .join("\n")
            : "NO KNOWLEDGE HAS BEEN TAUGHT YET.";

        /*
         * IMPORTANT:
         *
         * Gemini is being used here as the language engine.
         * The notebook is supposed to be the AI's source of knowledge.
         *
         * The model is explicitly told NOT to use its pretrained
         * knowledge to answer factual questions.
         */
        const prompt = `
You are a learning AI.

Your knowledge is LIMITED to the information contained in the
"TAUGHT KNOWLEDGE" section below.

You already have the ability to understand English, understand
questions, reason about the information you have been given, and
have natural conversations.

However, you MUST NOT use your pretrained/world knowledge to provide
facts that are not contained in the taught knowledge.

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

5. Do NOT fill missing information with information you already knew
   before this conversation.

6. Do NOT pretend to know something that has not been taught.

7. If the user is teaching you something rather than asking a
   question, acknowledge it naturally.

8. Keep responses natural and conversational.

9. If the user asks something like "what do you know?", describe
   only information contained in the taught knowledge.

10. Your ability to understand English is separate from your factual
    knowledge. You can understand a question even if you don't know
    its answer.

Answer the user's message now.
`;

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

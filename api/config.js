const { readFile } = require("node:fs/promises");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const dataset = JSON.parse(await readFile("extracted_financial_qa.json", "utf8"));
  res.status(200).json({
    datasetCount: dataset.length,
    topics: [...new Set(dataset.map((item) => item.topic))].sort(),
    thresholds: {
      directAnswer: Number(process.env.DIRECT_ANSWER_THRESHOLD || 0.92),
      focusedRag: Number(process.env.FOCUSED_RAG_THRESHOLD || 0.45),
      ragMinimum: Number(process.env.RAG_MIN_THRESHOLD || 0.18),
      aiConfidence: Number(process.env.AI_CONFIDENCE_THRESHOLD || 0.68),
      ragUncertainty: Number(process.env.RAG_UNCERTAINTY_THRESHOLD || 0.55),
      ragContextLimit: Number(process.env.RAG_CONTEXT_LIMIT || 12),
    },
    integrations: {
      runyouraiConfigured: Boolean(
        process.env.RUNYOURAI_API_KEY &&
          process.env.RUNYOURAI_BASE_URL &&
          process.env.RUNYOURAI_MODEL,
      ),
      discordConfigured: Boolean(process.env.DISCORD_WEBHOOK_URL),
    },
  });
};

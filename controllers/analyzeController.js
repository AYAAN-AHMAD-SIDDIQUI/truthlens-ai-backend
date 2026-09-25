const axios = require("axios");
const cheerio = require("cheerio");

const prisma = require("../config/prisma");
const ai = require("../config/gemini");

const analyzeNews = async (req, res) => {
  try {
    const { url, articleText } = req.body;

    // ==========================================
    // 1. CHECK INPUT
    // ==========================================

    if (!url && !articleText) {
      return res.status(400).json({
        success: false,
        message: "URL or article text is required",
      });
    }

    let content = articleText || "";
    let title = "News Article";

    // ==========================================
    // 2. SCRAPE ARTICLE FROM URL
    // ==========================================

    if (url) {
      try {
        const response = await axios.get(url, {
          timeout: 10000,

          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
          },
        });

        const $ = cheerio.load(response.data);

        // Get title
        title = $("title").text().trim() || "News Article";

        // Remove unnecessary elements
        $("script").remove();
        $("style").remove();
        $("noscript").remove();

        // Extract body text
        const scrapedText = $("body")
          .text()
          .replace(/\s+/g, " ")
          .trim();

        if (scrapedText.length > 0) {
          content = scrapedText;
        }
      } catch (scrapeError) {
        console.log(
          "SCRAPING ERROR:",
          scrapeError.message
        );

        // If URL scraping fails but user provided article text,
        // continue using article text.
        if (!articleText) {
          return res.status(400).json({
            success: false,
            message:
              "Could not read this URL. Please paste the article text manually.",
          });
        }
      }
    }

    // ==========================================
    // 3. VALIDATE ARTICLE
    // ==========================================

    if (!content || content.trim().length < 20) {
      return res.status(400).json({
        success: false,
        message: "Article content is too short.",
      });
    }

    // Maximum article size
    content = content.substring(0, 12000);

    // ==========================================
    // 4. GEMINI PROMPT
    // ==========================================

    const prompt = `
You are an AI news verification assistant.

Analyze the following news article.

Return ONLY valid JSON.

The JSON must contain exactly these fields:

{
  "summary": "short summary",
  "fakeScore": 0,
  "credibilityScore": 0,
  "bias": "Neutral",
  "sentiment": "Neutral"
}

Rules:

- fakeScore must be a number from 0 to 100.
- credibilityScore must be a number from 0 to 100.
- bias must be one of:
  Neutral, Left, Right, Mixed

- sentiment must be one of:
  Positive, Negative, Neutral

- Keep the summary short.
- Do not use Markdown.
- Do not add any explanation outside the JSON.
- Base the analysis only on the article provided.

ARTICLE:

${content}
`;

    // ==========================================
    // 5. GEMINI 3.5 FLASH
    // ==========================================

    const result = await ai.models.generateContent({
      model:
        process.env.GEMINI_MODEL ||
        "gemini-3.5-flash",

      contents: prompt,

      config: {
        thinkingConfig: {
          thinkingLevel: "low",
        },

        responseMimeType: "application/json",

        responseSchema: {
          type: "OBJECT",

          properties: {
            summary: {
              type: "STRING",
            },

            fakeScore: {
              type: "NUMBER",
            },

            credibilityScore: {
              type: "NUMBER",
            },

            bias: {
              type: "STRING",

              enum: [
                "Neutral",
                "Left",
                "Right",
                "Mixed",
              ],
            },

            sentiment: {
              type: "STRING",

              enum: [
                "Positive",
                "Negative",
                "Neutral",
              ],
            },
          },

          required: [
            "summary",
            "fakeScore",
            "credibilityScore",
            "bias",
            "sentiment",
          ],
        },
      },
    });

    // ==========================================
    // 6. GET GEMINI RESPONSE
    // ==========================================

    const aiText = result.text;

    console.log(
      "GEMINI RESPONSE:",
      aiText
    );

    if (!aiText) {
      return res.status(500).json({
        success: false,
        message:
          "Gemini returned an empty response.",
      });
    }

    // ==========================================
    // 7. PARSE JSON
    // ==========================================

    let analysis;

    try {
      analysis = JSON.parse(aiText);
    } catch (jsonError) {
      console.error(
        "JSON PARSE ERROR:",
        jsonError.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Gemini returned invalid analysis data.",
      });
    }

    // ==========================================
    // 8. NORMALIZE SCORES
    // ==========================================

    const fakeScore = Math.min(
      100,
      Math.max(
        0,
        Number(analysis.fakeScore) || 0
      )
    );

    const credibilityScore = Math.min(
      100,
      Math.max(
        0,
        Number(analysis.credibilityScore) || 0
      )
    );

    const summary =
      analysis.summary ||
      "No summary available.";

    const bias =
      analysis.bias ||
      "Neutral";

    const sentiment =
      analysis.sentiment ||
      "Neutral";

    // ==========================================
    // 9. FINAL VERDICT
    // ==========================================

    let finalVerdict;
    let verdictType;

    if (fakeScore >= 50) {
      finalVerdict = "Likely Fake News";
      verdictType = "FAKE";
    } else if (credibilityScore >= 70) {
      finalVerdict = "Likely Genuine News";
      verdictType = "GENUINE";
    } else {
      finalVerdict = "Needs Verification";
      verdictType = "UNCERTAIN";
    }

    // ==========================================
    // 10. SAVE TO DATABASE
    // ==========================================

    const savedAnalysis =
      await prisma.analysis.create({
        data: {
          title,

          url: url || null,

          articleText: content,

          summary,

          fakeScore,

          credibilityScore,

          bias,

          sentiment,

          userId: req.user.id,
        },
      });

    // ==========================================
    // 11. SEND RESPONSE
    // ==========================================

    return res.status(200).json({
      success: true,

      message:
        "Analysis saved successfully",

      analysis: {
        ...savedAnalysis,

        finalVerdict,

        verdictType,
      },
    });
  } catch (error) {
    // ==========================================
    // ERROR HANDLING
    // ==========================================

    console.error(
      "ANALYZE ERROR:",
      error
    );

    // Rate limit
    if (error.status === 429) {
      return res.status(429).json({
        success: false,

        message:
          "Gemini API rate limit reached. Please try again shortly.",
      });
    }

    // Authentication
    if (
      error.status === 401 ||
      error.status === 403
    ) {
      return res.status(500).json({
        success: false,

        message:
          "Gemini API authentication failed. Check GEMINI_API_KEY.",
      });
    }

    // Other errors
    return res.status(500).json({
      success: false,

      message:
        "News analysis failed.",

      error: error.message,
    });
  }
};

module.exports = {
  analyzeNews,
};
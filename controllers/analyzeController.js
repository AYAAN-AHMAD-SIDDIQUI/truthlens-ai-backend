const axios = require("axios");
const cheerio = require("cheerio");
const prisma = require("../config/prisma");
const ai = require("../config/gemini");

// ==========================================
// ANALYZE NEWS
// ==========================================

const analyzeNews = async (req, res) => {
  try {
    const { url, articleText } = req.body;

    console.log("===== ANALYZE REQUEST =====");
    console.log("URL:", url);

    // 1. CHECK INPUT
    if (!url?.trim() && !articleText?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Please provide a URL or article text.",
      });
    }

    let content = articleText?.trim() || "";

    // 2. SCRAPE URL IF PROVIDED
    if (url?.trim()) {
      console.log("Scraping URL...");

      const response = await axios.get(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36",

          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

          "Accept-Language":
            "en-US,en;q=0.9",

          Referer:
            "https://www.google.com/",
        },

        timeout: 15000,
      });

      const $ = cheerio.load(response.data);

      content = "";

      $("p").each((i, el) => {
        const text = $(el).text().trim();

        if (text) {
          content += text + "\n";
        }
      });

      if (!content.trim()) {
        return res.status(400).json({
          success: false,
          message:
            "Could not extract article text from this URL.",
        });
      }
    }

    console.log(
      "CONTENT LENGTH:",
      content.length
    );

    // 3. LIMIT ARTICLE SIZE
    const MAX_CONTENT_LENGTH = 12000;

    if (content.length > MAX_CONTENT_LENGTH) {
      content =
        content.substring(
          0,
          MAX_CONTENT_LENGTH
        );

      console.log(
        "ARTICLE TRIMMED TO:",
        content.length
      );
    }

    // 4. CHECK GEMINI API KEY
    if (!process.env.GEMINI_API_KEY) {
      console.error(
        "GEMINI_API_KEY is missing"
      );

      return res.status(500).json({
        success: false,
        message:
          "Gemini API key is missing in backend environment.",
      });
    }

    // 5. GEMINI PROMPT
    const prompt = `
Analyze this news article and return ONLY valid JSON.

Format:

{
  "summary": "short summary",
  "fakeScore": 0,
  "credibilityScore": 0,
  "bias": "Neutral",
  "sentiment": "Neutral"
}

Rules:

- fakeScore: 0-100, higher means greater misinformation risk.
- credibilityScore: 0-100, higher means more credible.
- bias: Neutral, Left, Right, or Mixed.
- sentiment: Positive, Negative, or Neutral.
- Keep summary short and clear.
- Do not use markdown.
- Do not add anything outside JSON.

Article:

${content}
`;

    // 6. GEMINI 3.6 FLASH
    console.log(
      "Sending article to Gemini 3.6 Flash..."
    );

    const aiResponse =
      await ai.models.generateContent({
        model:
          process.env.GEMINI_MODEL ||
          "gemini-3.6-flash",

        contents: prompt,

        config: {
          responseMimeType:
            "application/json",

          thinkingConfig: {
            thinkingLevel: "low",
          },
        },
      });

    console.log(
      "Gemini response received"
    );

    const aiContent =
      aiResponse.text;

    console.log(
      "AI RESPONSE:",
      aiContent
    );

    if (!aiContent) {
      return res.status(500).json({
        success: false,
        message:
          "Gemini returned an empty response.",
      });
    }

    // 7. PARSE GEMINI JSON
    let analysis;

    try {
      analysis =
        JSON.parse(aiContent);
    } catch (error) {
      console.error(
        "JSON PARSE ERROR:",
        error
      );

      console.error(
        "RAW GEMINI RESPONSE:",
        aiContent
      );

      return res.status(500).json({
        success: false,
        message:
          "Gemini returned invalid JSON.",
      });
    }

    console.log(
      "ANALYSIS:",
      analysis
    );

    // 8. NORMALIZE SCORES
    const fakeScore =
      Math.min(
        100,
        Math.max(
          0,
          Number(
            analysis.fakeScore
          ) || 0
        )
      );

    const credibilityScore =
      Math.min(
        100,
        Math.max(
          0,
          Number(
            analysis.credibilityScore
          ) || 0
        )
      );

    // 9. FINAL VERDICT
    let finalVerdict;
    let verdictType;

    if (fakeScore >= 50) {
      finalVerdict =
        "Likely Fake News";

      verdictType = "FAKE";
    } else if (
      credibilityScore >= 70
    ) {
      finalVerdict =
        "Likely Genuine News";

      verdictType = "GENUINE";
    } else {
      finalVerdict =
        "Needs Verification";

      verdictType = "UNCERTAIN";
    }

    console.log(
      "FAKE SCORE:",
      fakeScore
    );

    console.log(
      "CREDIBILITY SCORE:",
      credibilityScore
    );

    console.log(
      "FINAL VERDICT:",
      finalVerdict
    );

    console.log(
      "VERDICT TYPE:",
      verdictType
    );

    // 10. SAVE ANALYSIS
    const savedAnalysis =
      await prisma.analysis.create({
        data: {
          title:
            url?.trim() ||
            "Manual News",

          url:
            url?.trim() ||
            null,

          articleText:
            content,

          summary:
            analysis.summary ||
            "",

          fakeScore:
            fakeScore,

          credibilityScore:
            credibilityScore,

          bias:
            analysis.bias ||
            "Neutral",

          sentiment:
            analysis.sentiment ||
            "Neutral",

          userId:
            req.user.id,
        },
      });

    console.log(
      "ANALYSIS SAVED:",
      savedAnalysis.id
    );

    // 11. SEND RESULT TO FRONTEND
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

  } catch (err) {
    console.error(
      "===== ANALYZE ERROR ====="
    );

    console.error(
      "MESSAGE:",
      err.message
    );

    console.error(
      "STATUS:",
      err.status
    );

    console.error(
      "DATA:",
      err.response?.data
    );

    // URL SCRAPING BLOCKED
    if (
      err.response?.status === 403
    ) {
      return res.status(400).json({
        success: false,
        message:
          "This website does not allow automatic article access. Please paste the article text instead.",
      });
    }

    // GEMINI AUTHENTICATION ERROR
    if (
      err.status === 401 ||
      err.status === 403 ||
      err.message
        ?.toLowerCase()
        .includes("api key")
    ) {
      return res.status(500).json({
        success: false,
        message:
          "Gemini authentication failed. Please check the Gemini API key.",
      });
    }

    // GEMINI RATE LIMIT
    if (err.status === 429) {
      return res.status(429).json({
        success: false,
        message:
          "Gemini rate limit reached. Please try again later.",
      });
    }

    // GEMINI SERVICE UNAVAILABLE
    if (err.status === 503) {
      return res.status(503).json({
        success: false,
        message:
          "Gemini is currently experiencing high demand. Please try again in a few moments.",
      });
    }

    // TIMEOUT
    if (
      err.code === "ECONNABORTED" ||
      err.code === "ETIMEDOUT"
    ) {
      return res.status(408).json({
        success: false,
        message:
          "The request took too long. Please try again.",
      });
    }

    // GENERAL ERROR
    return res.status(500).json({
      success: false,

      message:
        err.response?.data?.error?.message ||
        err.response?.data?.message ||
        err.message ||
        "Internal Server Error",
    });
  }
};

// ==========================================
// DASHBOARD STATS
// ==========================================

const getDashboardStats =
  async (req, res) => {
    try {
      const analyses =
        await prisma.analysis.findMany({
          where: {
            userId: req.user.id,
          },

          orderBy: {
            createdAt: "desc",
          },
        });

      const totalAnalyses =
        analyses.length;

      const averageCredibility =
        totalAnalyses > 0
          ? analyses.reduce(
              (sum, item) =>
                sum +
                Number(
                  item.credibilityScore ||
                    0
                ),
              0
            ) / totalAnalyses
          : 0;

      const fakeNewsDetected =
        analyses.filter(
          (item) =>
            Number(
              item.fakeScore || 0
            ) >= 50
        ).length;

      return res.status(200).json({
        success: true,

        stats: {
          totalAnalyses,

          averageCredibility:
            Math.round(
              averageCredibility
            ),

          fakeNewsDetected,

          articlesChecked:
            totalAnalyses,
        },

        recentAnalyses:
          analyses.slice(0, 5),
      });

    } catch (error) {
      console.error(
        "DASHBOARD STATS ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to fetch dashboard statistics.",
      });
    }
  };

// ==========================================
// EXPORT
// ==========================================

module.exports = {
  analyzeNews,
  getDashboardStats,
};
const axios = require("axios");
const cheerio = require("cheerio");
const prisma = require("../config/prisma");

const analyzeNews = async (req, res) => {
  try {
    const { url, articleText } = req.body;

    console.log("===== ANALYZE REQUEST =====");
    console.log("URL:", url);
    console.log("Article:", articleText);

    // 1. Check input
    if (!url?.trim() && !articleText?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Please provide a URL or article text.",
      });
    }

    let content = articleText?.trim() || "";

    // 2. If URL is provided, scrape article
    if (url?.trim()) {
      console.log("Scraping URL...");

      const response = await axios.get(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.google.com/",
          Connection: "keep-alive",
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
          message: "Could not extract article text from this URL.",
        });
      }
    }

    console.log("CONTENT LENGTH:", content.length);

    // 3. Check OpenRouter API key
    if (!process.env.OPENROUTER_API_KEY) {
      console.error("OPENROUTER_API_KEY is missing");

      return res.status(500).json({
        success: false,
        message: "OpenRouter API key is missing in backend .env file.",
      });
    }

    // 4. Send article to OpenRouter
    console.log("Sending article to OpenRouter...");

    const aiResponse = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "nvidia/nemotron-3-ultra-550b-a55b:free",

        messages: [
          {
            role: "system",
            content:
              "You are an AI news analysis assistant. Return only valid JSON.",
          },
          {
            role: "user",
            content: `
Analyze this news article.

Return ONLY JSON in exactly this format:

{
  "summary": "short summary",
  "fakeScore": 0,
  "credibilityScore": 0,
  "bias": "Neutral",
  "sentiment": "Neutral"
}

fakeScore must be a number from 0 to 100.
credibilityScore must be a number from 0 to 100.

Article:
${content}
`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );

    console.log("OpenRouter response received");

    const aiContent =
      aiResponse.data?.choices?.[0]?.message?.content;

    console.log("AI RESPONSE:", aiContent);

    if (!aiContent) {
      return res.status(500).json({
        success: false,
        message: "OpenRouter returned an empty response.",
      });
    }

    // 5. Parse AI JSON
    let analysis;

    try {
      analysis = JSON.parse(aiContent);
    } catch (error) {
      console.error("JSON PARSE ERROR:", error);
      console.error("RAW AI RESPONSE:", aiContent);

      return res.status(500).json({
        success: false,
        message: "AI returned invalid JSON.",
      });
    }

    console.log("ANALYSIS:", analysis);

    // 6. Save in database
    const savedAnalysis = await prisma.analysis.create({
      data: {
        title: url?.trim() || "Manual News",
        url: url?.trim() || null,
        articleText: content,
        summary: analysis.summary || "",
        fakeScore: Number(analysis.fakeScore) || 0,
        credibilityScore:
          Number(analysis.credibilityScore) || 0,
        bias: analysis.bias || "Neutral",
        sentiment: analysis.sentiment || "Neutral",
        userId: req.user.id,
      },
    });

    console.log("ANALYSIS SAVED:", savedAnalysis.id);

    // 7. Send result to frontend
    return res.status(200).json({
      success: true,
      message: "Analysis saved successfully",
      analysis: savedAnalysis,
    });
  } catch (err) {
    console.error("===== ANALYZE ERROR =====");
    console.error("MESSAGE:", err.message);
    console.error("STATUS:", err.response?.status);
    console.error("DATA:", err.response?.data);

    // URL scraping blocked
    if (err.response?.status === 403) {
      return res.status(400).json({
        success: false,
        message:
          "This website does not allow automatic article access. Please paste the article text instead.",
      });
    }

    // OpenRouter authentication error
    if (err.response?.status === 401) {
      return res.status(500).json({
        success: false,
        message:
          "AI service authentication failed. Please check the OpenRouter API key.",
      });
    }

    // OpenRouter rate limit
    if (err.response?.status === 429) {
      return res.status(429).json({
        success: false,
        message:
          "AI service rate limit reached. Please try again after a short while.",
      });
    }

    // Request timeout
    if (err.code === "ECONNABORTED") {
      return res.status(408).json({
        success: false,
        message:
          "The request took too long. Please try again.",
      });
    }

    // General error
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

const getDashboardStats = async (req, res) => {
  try {
    const analyses = await prisma.analysis.findMany({
      where: {
        userId: req.user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const totalAnalyses = analyses.length;

    const averageCredibility =
      totalAnalyses > 0
        ? analyses.reduce(
            (sum, item) =>
              sum + Number(item.credibilityScore || 0),
            0
          ) / totalAnalyses
        : 0;

    const fakeNewsDetected = analyses.filter(
      (item) => Number(item.fakeScore || 0) >= 50
    ).length;

    return res.status(200).json({
      success: true,

      stats: {
        totalAnalyses,
        averageCredibility: Math.round(averageCredibility),
        fakeNewsDetected,
        articlesChecked: totalAnalyses,
      },

      recentAnalyses: analyses.slice(0, 5),
    });
  } catch (error) {
    console.error("DASHBOARD STATS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard statistics.",
    });
  }
};


module.exports = {
  analyzeNews,
  getDashboardStats,
};
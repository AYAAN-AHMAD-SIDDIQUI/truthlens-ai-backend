const axios = require("axios");
const cheerio = require("cheerio");
const dns = require("node:dns").promises;
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const prisma = require("../config/prisma");
const ai = require("../config/gemini");

const isPublicIPv4 = (address) => {
  if (net.isIP(address) !== 4) return false;
  const parts = address.split(".").map(Number);
  const ip = parts.reduce((value, part) => ((value * 256) + part) >>> 0, 0) >>> 0;
  const blocked = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
    ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];

  return !blocked.some(([base, bits]) => {
    const baseIp = base.split(".").map(Number)
      .reduce((value, part) => ((value * 256) + part) >>> 0, 0) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (baseIp & mask);
  });
};

const getSafeArticleUrl = async (rawUrl) => {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Please provide a valid article URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol) ||
      parsed.username || parsed.password ||
      (parsed.port && !["80", "443"].includes(parsed.port))) {
    throw new Error("Only public HTTP/HTTPS article URLs are supported.");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  let pinnedAddress;

  if (net.isIP(hostname)) {
    if (!isPublicIPv4(hostname)) {
      throw new Error("This URL points to a non-public network and cannot be fetched.");
    }
    pinnedAddress = hostname;
  } else {
    // Resolve only IPv4 records and pin the chosen public address for the request.
    // This avoids accidentally rejecting dual-stack public websites because of their AAAA record.
    const records = await dns.resolve4(hostname);
    if (!records.length || records.some((address) => !isPublicIPv4(address))) {
      throw new Error("This URL does not resolve exclusively to public IPv4 addresses.");
    }
    pinnedAddress = records[0];
  }

  const pinnedLookup = (requestedHost, options, callback) => {
    if (options && options.all) {
      return callback(null, [{ address: pinnedAddress, family: 4 }]);
    }
    return callback(null, pinnedAddress, 4);
  };

  const agentOptions = { lookup: pinnedLookup };
  return {
    url: parsed.toString(),
    httpAgent: new http.Agent(agentOptions),
    httpsAgent: new https.Agent(agentOptions),
  };
};

const validateAnalysis = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gemini returned an invalid analysis object.");
  }

  const scoreIsValid = (score) =>
    typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100;

  const allowedBias = ["Neutral", "Left", "Right", "Mixed"];
  const allowedSentiment = ["Positive", "Negative", "Neutral"];

  if (typeof value.summary !== "string" || !value.summary.trim() ||
      !scoreIsValid(value.fakeScore) ||
      !scoreIsValid(value.credibilityScore) ||
      !allowedBias.includes(value.bias) ||
      !allowedSentiment.includes(value.sentiment)) {
    throw new Error("Gemini response is missing valid summary, scores, bias, or sentiment fields.");
  }

  return {
    summary: value.summary.trim().slice(0, 1200),
    fakeScore: Math.round(value.fakeScore),
    credibilityScore: Math.round(value.credibilityScore),
    bias: value.bias,
    sentiment: value.sentiment,
  };
};

const analyzeNews = async (req, res) => {
  try {
    const { url, articleText } = req.body || {};
    const normalizedUrl = typeof url === "string" ? url.trim() : "";
    let content = typeof articleText === "string" ? articleText.trim() : "";

    if (!normalizedUrl && !content) {
      return res.status(400).json({
        success: false,
        message: "Please provide a URL or article text.",
      });
    }

    if (normalizedUrl) {
      const safeTarget = await getSafeArticleUrl(normalizedUrl);
      const response = await axios.get(safeTarget.url, {
        httpAgent: safeTarget.httpAgent,
        httpsAgent: safeTarget.httpsAgent,
        maxRedirects: 0,
        timeout: 12000,
        maxContentLength: 1024 * 1024,
        maxBodyLength: 1024 * 1024,
        responseType: "text",
        headers: {
          "User-Agent": "TruthLensAI/1.0",
          Accept: "text/html,application/xhtml+xml",
        },
        validateStatus: (status) => status >= 200 && status < 300,
      });

      const contentType = String(response.headers["content-type"] || "").toLowerCase();
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        return res.status(415).json({
          success: false,
          message: "The URL did not return an HTML article page. Please paste the article text instead.",
        });
      }

      const $ = cheerio.load(response.data);
      content = $("p").map((i, element) => $(element).text().trim()).get()
        .filter(Boolean).join("\n");
    }

    if (!content.trim()) {
      return res.status(400).json({
        success: false,
        message: "Could not extract article text. Please paste the article text instead.",
      });
    }

    content = content.slice(0, 12000);

    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({
        success: false,
        message: "Gemini API key is not configured on the server.",
      });
    }

    const prompt = `
You are assisting with news literacy. Assess only the claims and evidence present in the supplied article.
Do not assume a claim is false merely because it is surprising, unfamiliar, or politically sensitive.
Do not assume a claim is true merely because the writing sounds professional.
If the article lacks enough verifiable evidence, use moderate/uncertain scores rather than inventing certainty.
Treat scores as estimates of misinformation risk and credibility, not proof or a fact-check verdict.
Return ONLY valid JSON in this exact shape:
{
  "summary": "short factual summary",
  "fakeScore": 0,
  "credibilityScore": 0,
  "bias": "Neutral",
  "sentiment": "Neutral"
}
Rules:
- fakeScore and credibilityScore must each be integers from 0 to 100.
- fakeScore is misinformation risk; 0 is very low risk and 100 is very high risk.
- credibilityScore is evidence-based credibility; 0 is very low and 100 is very high.
- The scores are related but are not required to add up to 100.
- Use "Neutral", "Left", "Right", or "Mixed" for bias.
- Use "Positive", "Negative", or "Neutral" for sentiment.
- Do not claim independent fact-checking or source verification unless the article itself provides evidence.
Article:
${content}
`;

    const aiResponse = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: "low" },
      },
    });

    const aiContent = aiResponse.text;
    if (!aiContent) {
      return res.status(502).json({
        success: false,
        message: "Gemini returned an empty response. Please try again.",
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(aiContent);
    } catch {
      return res.status(502).json({
        success: false,
        message: "Gemini returned an unreadable response. Please try again.",
      });
    }

    const analysis = validateAnalysis(parsed);
    let finalVerdict = "Needs Verification";
    let verdictType = "UNCERTAIN";

    if (analysis.fakeScore >= 50) {
      finalVerdict = "Likely Fake News";
      verdictType = "FAKE";
    } else if (analysis.credibilityScore >= 70) {
      finalVerdict = "Likely Genuine News";
      verdictType = "GENUINE";
    }

    const savedAnalysis = await prisma.analysis.create({
      data: {
        title: normalizedUrl || "Manual News",
        url: normalizedUrl || null,
        articleText: content,
        summary: analysis.summary,
        fakeScore: analysis.fakeScore,
        credibilityScore: analysis.credibilityScore,
        bias: analysis.bias,
        sentiment: analysis.sentiment,
        userId: req.user.id,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Analysis saved successfully",
      analysis: { ...savedAnalysis, finalVerdict, verdictType },
    });
  } catch (error) {
    console.error("ANALYZE ERROR:", error.message);

    if (error.message.includes("URL") || error.message.includes("public network") ||
        error.message.includes("public IPv4")) {
      return res.status(400).json({ success: false, message: error.message });
    }
    if (error.response?.status === 403) {
      return res.status(400).json({
        success: false,
        message: "This website blocks automatic article access. Please paste the article text instead.",
      });
    }
    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return res.status(408).json({ success: false, message: "The article request timed out. Please try again." });
    }
    if (error.response?.status === 429 || error.status === 429) {
      return res.status(429).json({ success: false, message: "Gemini rate limit reached. Please try again later." });
    }
    if (error.status === 503 || error.status === 401 || error.status === 403) {
      return res.status(error.status).json({
        success: false,
        message: error.status === 503
          ? "Gemini is temporarily unavailable. Please try again shortly."
          : "Gemini authentication failed. Please check the server API key.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to analyze this article right now. Please try again.",
    });
  }
};

const getDashboardStats = async (req, res) => {
  try {
    const analyses = await prisma.analysis.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
    });

    const totalAnalyses = analyses.length;
    const averageCredibility = totalAnalyses
      ? analyses.reduce((sum, item) => sum + Number(item.credibilityScore), 0) / totalAnalyses
      : 0;
    const fakeNewsDetected = analyses.filter((item) => Number(item.fakeScore) >= 50).length;

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
    console.error("DASHBOARD STATS ERROR:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard statistics.",
    });
  }
};

module.exports = { analyzeNews, getDashboardStats };

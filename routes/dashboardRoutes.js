const express = require("express");
const router = express.Router();

const prisma = require("../config/prisma");
const authMiddleware = require("../middleware/authMiddleware");

router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const analyses = await prisma.analysis.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    const totalAnalyses = analyses.length;

    const averageCredibility =
      totalAnalyses === 0
        ? 0
        : Math.round(
            analyses.reduce(
              (sum, item) => sum + (item.credibilityScore || 0),
              0
            ) / totalAnalyses
          );

    const fakeNewsDetected = analyses.filter(
      (item) => (item.fakeScore || 0) >= 50
    ).length;

    const recentAnalyses = analyses.slice(0, 5);

    res.json({
      success: true,
      stats: {
        totalAnalyses,
        averageCredibility,
        fakeNewsDetected,
        articlesChecked: totalAnalyses,
      },
      recentAnalyses,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "Dashboard fetch failed",
    });
  }
});

module.exports = router;
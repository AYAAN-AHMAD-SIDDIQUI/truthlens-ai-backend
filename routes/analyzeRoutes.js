const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const { analyzeNews, getDashboardStats } = require("../controllers/analyzeController");
router.post("/", authMiddleware, analyzeNews);
router.get("/dashboard", authMiddleware, getDashboardStats);
module.exports = router;
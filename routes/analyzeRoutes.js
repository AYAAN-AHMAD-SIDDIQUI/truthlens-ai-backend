const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const analyzeController = require("../controllers/analyzeController");

console.log("authMiddleware type:", typeof authMiddleware);
console.log("getDashboardStats type:", typeof analyzeController.getDashboardStats);
console.log("analyzeNews type:", typeof analyzeController.analyzeNews);

router.post("/", authMiddleware, analyzeController.analyzeNews);
router.get("/dashboard", authMiddleware, analyzeController.getDashboardStats);

module.exports = router;
const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");

const {
  getHistory,
  getSingleHistory,
  deleteHistory,
} = require("../controllers/historyController");

router.get("/", authMiddleware, getHistory);

router.get("/:id", authMiddleware, getSingleHistory);

router.delete("/:id", authMiddleware, deleteHistory);

module.exports = router;
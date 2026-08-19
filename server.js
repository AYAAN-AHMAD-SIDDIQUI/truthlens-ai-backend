const express = require("express");
const cors = require("cors");
require("dotenv").config();

const authRoutes = require("./routes/authRoutes");
const analysisRoutes = require("./routes/analyzeRoutes");
const historyRoutes = require("./routes/historyRoutes");

const app = express();

// =======================
// Middlewares
// =======================
app.use(cors());
app.use(express.json());

// =======================
// Routes
// =======================
app.use("/api/auth", authRoutes);
app.use("/api/analyze", analysisRoutes);
app.use("/api/history", historyRoutes);

// Test Route
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "TruthLens AI Backend Running 🚀",
  });
});

// =======================
// Server
// =======================
const PORT = process.env.PORT || 5000;



app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});
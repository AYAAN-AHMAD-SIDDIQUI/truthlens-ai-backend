const jwt = require("jsonwebtoken");

const authMiddleware = (req, res, next) => {
  const authorization = req.headers.authorization;

  if (!authorization) {
    return res.status(401).json({ message: "Access Denied. No Token Provided" });
  }

  const [scheme, token, ...extraParts] = authorization.trim().split(/\s+/);
  if (scheme !== "Bearer" || !token || extraParts.length > 0) {
    return res.status(401).json({ message: "Authorization must use Bearer token format." });
  }

  if (!process.env.JWT_SECRET) {
    console.error("JWT_SECRET is not configured.");
    return res.status(500).json({ message: "Authentication is not configured on the server." });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or Expired Token" });
  }
};

module.exports = authMiddleware;

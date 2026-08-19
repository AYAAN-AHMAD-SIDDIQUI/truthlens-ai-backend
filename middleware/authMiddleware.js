const jwt = require("jsonwebtoken");

const authMiddleware = (req, res, next) => {
const token = req.headers.authorization;

if (!token) {
  return res.status(401).json({
    message: "Access Denied. No Token Provided",
  });
}
const jwtToken = token.split(" ")[1];
try {
  const decoded = jwt.verify(jwtToken, process.env.JWT_SECRET);

  req.user = decoded;

  next();
} catch (error) {
  return res.status(401).json({
    message: "Invalid or Expired Token",
  });
}
};

module.exports = authMiddleware;

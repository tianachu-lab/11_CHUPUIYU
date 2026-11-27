const jwt = require("jsonwebtoken");

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "請先登入會員" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.SESSION_SECRET);
    req.user = decoded; // 裡面會有 { id, username }
    next();
  } catch (err) {
    return res.status(401).json({ error: "登入已過期或無效，請重新登入" });
  }
}

module.exports = authMiddleware;

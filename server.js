require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Tesseract = require("tesseract.js");
const db = require("./db");
const authMiddleware = require("./authMiddleware");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "uploads")),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("只允許上傳 JPG、PNG 或 WEBP 格式的相片"));
  },
});

// 執行 OCR 文字辨識（優先使用 Gemini Vision OCR，若無 Key 則退回 Tesseract.js）
async function extractTextFromImage(imagePath, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    const imageBase64 = fs.readFileSync(imagePath, { encoding: "base64" });
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: "請執行精準的 OCR 文字辨識，完整擷取這張圖片中的所有文字內容（保持原本的繁體中文、英文與數字，不要自行編造或加入額外說明）。若圖片中沒有任何文字，請只回覆「無文字」。",
              },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: imageBase64,
                },
              },
            ],
          },
        ],
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return text.trim();
    }
  }

  // 備援方案：使用本機 Tesseract.js 進行 OCR
  const result = await Tesseract.recognize(imagePath, "eng+chi_tra");
  return (result.data.text || "").trim();
}

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.trim().length < 3 || password.length < 6) {
    return res.status(400).json({ error: "帳號至少 3 個字元，密碼至少 6 個字元" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    db.run(
      "INSERT INTO users (username, password_hash) VALUES (?, ?)",
      [username.trim(), passwordHash],
      function (err) {
        if (err) {
          if (err.message.includes("UNIQUE")) {
            return res.status(409).json({ error: "此帳號已被註冊" });
          }
          return res.status(500).json({ error: "註冊失敗" });
        }
        res.status(201).json({ message: "註冊成功", userId: this.lastID });
      }
    );
  } catch (err) {
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "請輸入帳號與密碼" });
  }

  db.get("SELECT * FROM users WHERE username = ?", [username.trim()], async (err, user) => {
    if (err) return res.status(500).json({ error: "資料庫錯誤" });
    if (!user) return res.status(401).json({ error: "帳號或密碼錯誤" });

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(401).json({ error: "帳號或密碼錯誤" });

    const token = jwt.sign(
      { id: user.id, username: user.username },
      process.env.SESSION_SECRET,
      { expiresIn: "2h" }
    );
    res.json({ message: "登入成功", token, username: user.username });
  });
});

app.post("/documents", authMiddleware, upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "請選擇要上傳的相片檔案" });
  }

  const imagePath = req.file.path;
  try {
    const extractedText = await extractTextFromImage(imagePath, req.file.mimetype);

    db.run(
      "INSERT INTO documents (user_id, original_name, stored_name, extracted_text) VALUES (?, ?, ?, ?)",
      [req.user.id, req.file.originalname, req.file.filename, extractedText],
      function (err) {
        if (err) {
          return res.status(500).json({ error: "儲存文件資料失敗" });
        }
        res.status(201).json({
          message: "相片上傳與 OCR 辨識完成",
          document: {
            id: this.lastID,
            original_name: req.file.originalname,
            image_url: `/uploads/${req.file.filename}`,
            extracted_text: extractedText,
          },
        });
      }
    );
  } catch (err) {
    if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
    res.status(500).json({ error: "OCR 文字辨識失敗：" + err.message });
  }
});

app.get("/documents", authMiddleware, (req, res) => {
  const queryText = (req.query.query || "").trim();

  if (queryText) {
    const sql = `
      SELECT id, original_name, stored_name, extracted_text, created_at
      FROM documents
      WHERE user_id = ? AND (extracted_text LIKE ? OR original_name LIKE ?)
      ORDER BY created_at DESC
    `;
    const keyword = `%${queryText}%`;
    db.all(sql, [req.user.id, keyword, keyword], (err, rows) => {
      if (err) return res.status(500).json({ error: "搜尋文件失敗" });
      const results = rows.map((row) => ({
        ...row,
        image_url: `/uploads/${row.stored_name}`,
      }));
      res.json({ query: queryText, count: results.length, documents: results });
    });
  } else {
    const sql = `
      SELECT id, original_name, stored_name, extracted_text, created_at
      FROM documents
      WHERE user_id = ?
      ORDER BY created_at DESC
    `;
    db.all(sql, [req.user.id], (err, rows) => {
      if (err) return res.status(500).json({ error: "讀取文件列表失敗" });
      const results = rows.map((row) => ({
        ...row,
        image_url: `/uploads/${row.stored_name}`,
      }));
      res.json({ count: results.length, documents: results });
    });
  }
});

app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || "請求發生錯誤" });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = app;

app.delete("/documents/:id", authMiddleware, (req, res) => {
  const docId = Number(req.params.id);
  if (!Number.isInteger(docId) || docId <= 0) {
    return res.status(400).json({ error: "無效的文件編號" });
  }

  // 先查詢該筆文件是否屬於目前登入的使用者
  db.get(
    "SELECT id, stored_name FROM documents WHERE id = ? AND user_id = ?",
    [docId, req.user.id],
    (err, doc) => {
      if (err) return res.status(500).json({ error: "查詢文件失敗" });
      if (!doc) return res.status(404).json({ error: "找不到該筆文件或無權限刪除" });

      // 刪除資料庫紀錄
      db.run(
        "DELETE FROM documents WHERE id = ? AND user_id = ?",
        [docId, req.user.id],
        function (delErr) {
          if (delErr) return res.status(500).json({ error: "刪除文件失敗" });

          // 同步刪除 uploads 資料夾內的實體圖片檔
          const filePath = path.join(__dirname, "uploads", doc.stored_name);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }

          res.json({ message: "已刪除該筆辨識紀錄", deletedId: docId });
        }
      );
    }
  );
});

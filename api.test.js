process.env.SESSION_SECRET = "ci_test_secret_key";
process.env.GEMINI_API_KEY = ""; // CI 測試環境不呼叫外部 API，直接驗證本機流程

const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const app = require("./server");

// 1x1 透明合法 PNG 圖片（用於測試上傳與資料庫流程）
const samplePngBuffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

test("完整系統流程測試：註冊、登入、上傳文件、列表與關鍵字搜尋", async () => {
  const uniqueUser = `ci_user_${Date.now()}`;
  const password = "password123";

  // 1. 註冊會員
  const regRes = await request(app)
    .post("/api/register")
    .send({ username: uniqueUser, password });
  assert.strictEqual(regRes.statusCode, 201);

  // 2. 會員登入取得 Token
  const loginRes = await request(app)
    .post("/api/login")
    .send({ username: uniqueUser, password });
  assert.strictEqual(loginRes.statusCode, 200);
  assert.ok(loginRes.body.token);
  const token = loginRes.body.token;

  // 3. 上傳相片 POST /documents
  const uploadRes = await request(app)
    .post("/documents")
    .set("Authorization", `Bearer ${token}`)
    .attach("image", samplePngBuffer, "test_receipt.png");
  assert.strictEqual(uploadRes.statusCode, 201);
  assert.strictEqual(uploadRes.body.document.original_name, "test_receipt.png");

  // 4. 取得所有文件 GET /documents
  const listRes = await request(app)
    .get("/documents")
    .set("Authorization", `Bearer ${token}`);
  assert.strictEqual(listRes.statusCode, 200);
  assert.strictEqual(listRes.body.count, 1);

  // 5. 關鍵字搜尋 GET /documents?query=search_text
  const searchRes = await request(app)
    .get("/documents?query=receipt")
    .set("Authorization", `Bearer ${token}`);
  assert.strictEqual(searchRes.statusCode, 200);
  assert.strictEqual(searchRes.body.count, 1);
});

setTimeout(() => process.exit(0), 500);

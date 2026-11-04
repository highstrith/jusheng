"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const COOKIE_NAME = "framepick_guest";
const DEFAULT_FILM_IDS = ["xianggu", "jinhaitang", "yanran"];
const MAX_BODY_BYTES = 16 * 1024;
const PAGE_SIZE = 20;

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function validRating(value) {
  return value === null || (Number.isInteger(value) && value >= 1 && value <= 10);
}

function shortText(value, limit) {
  return typeof value === "string" && Array.from(value).length <= limit;
}

function validatePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure(400, "评价必须是 JSON 对象。");
  const { nickname = "", text = "", rating = null } = value;
  if (!shortText(nickname, 24)) throw failure(400, "昵称最多 24 字。");
  if (!shortText(text, 1000)) throw failure(400, "评论最多 1000 字。");
  if (!validRating(rating)) throw failure(400, "评分须为 1–10 的整数或 null。");
  if (!text.trim() && rating === null) throw failure(400, "请填写评论或评分。");
  return { nickname: nickname.trim() || "访客", text: text.trim(), rating };
}

async function readJsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
    req.resume();
    throw failure(415, "请使用 application/json 提交评价。");
  }
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
    req.resume();
    throw failure(413, "请求正文过大。");
  }
  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overLimit = false;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overLimit = true;
        chunks.length = 0;
        reject(failure(413, "请求正文过大。"));
      } else if (!overLimit) chunks.push(chunk);
    });
    req.on("end", () => { if (!overLimit) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
    req.on("aborted", () => reject(failure(400, "请求已中断。")));
  });
  try { return JSON.parse(body); }
  catch (_) { throw failure(400, "请求正文须为有效 JSON。"); }
}

function validateDatabase(db) {
  if (!db || db.version !== 1 || !Array.isArray(db.reviews) || !db.guests
    || typeof db.guests !== "object" || Array.isArray(db.guests)) throw new Error("Invalid review database");
  const pairs = new Set();
  const ids = new Set();
  for (const review of db.reviews) {
    if (!review || typeof review.id !== "string" || !/^[\w-]+$/.test(review.id)
      || !/^[a-f0-9]{64}$/.test(review.visitorId) || typeof review.filmId !== "string"
      || !shortText(review.nickname, 24) || !shortText(review.text, 1000) || !validRating(review.rating)
      || (!review.text.trim() && review.rating === null)
      || typeof review.createdAt !== "string" || !Number.isFinite(Date.parse(review.createdAt))
      || typeof review.updatedAt !== "string" || !Number.isFinite(Date.parse(review.updatedAt))) throw new Error("Invalid stored review");
    const pair = `${review.visitorId}:${review.filmId}`;
    if (pairs.has(pair) || ids.has(review.id)) throw new Error("Duplicate stored review");
    pairs.add(pair);
    ids.add(review.id);
  }
  for (const [id, guest] of Object.entries(db.guests)) {
    if (!/^[a-f0-9]{64}$/.test(id) || !guest || !shortText(guest.nickname, 24)
      || !Number.isFinite(guest.lastWriteAt)) throw new Error("Invalid stored guest");
  }
  // Version 1 databases created before outbound rankings have no such field.
  if (db.outbound === undefined) db.outbound = [];
  if (!Array.isArray(db.outbound)) throw new Error("Invalid outbound database");
  const outboundPairs = new Set();
  for (const entry of db.outbound) {
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.visitorId) || typeof entry.filmId !== "string"
      || typeof entry.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day)
      || !Number.isFinite(Date.parse(entry.day)) || new Date(entry.day).toISOString().slice(0, 10) !== entry.day) throw new Error("Invalid outbound entry");
    const pair = `${entry.visitorId}:${entry.filmId}:${entry.day}`;
    if (outboundPairs.has(pair)) throw new Error("Duplicate outbound entry");
    outboundPairs.add(pair);
  }
  return db;
}

async function atomicWrite(file, db) {
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(db)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

/** One active handler/process per dataDir; the directory contains private server data. */
function createReviewHandler({
  dataDir = process.env.FRAMEPICK_REVIEWS_DATA_DIR || path.join(os.homedir(), ".framepick", "reviews"),
  filmIds = DEFAULT_FILM_IDS,
  cooldownMs = Number(process.env.FRAMEPICK_REVIEWS_COOLDOWN_MS ?? 1500),
  allowedOrigin = process.env.FRAMEPICK_REVIEWS_ALLOWED_ORIGIN || "",
  clock = Date.now,
} = {}) {
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new Error("Invalid review cooldown");
  const films = new Set(filmIds);
  if (!films.size || [...films].some(id => typeof id !== "string" || !/^[\w-]+$/.test(id))) throw new Error("Invalid film IDs");
  if (allowedOrigin) {
    const parsed = new URL(allowedOrigin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== allowedOrigin) throw new Error("Allowed origin must be one exact HTTP(S) origin");
  }
  const databaseFile = path.join(dataDir, "reviews.json");
  const keyFile = path.join(dataDir, "cookie-key");
  let db;
  let secret;
  let ready;
  let queue = Promise.resolve();

  async function initialize() {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    let existing = false;
    try {
      db = validateDatabase(JSON.parse(await fs.readFile(databaseFile, "utf8")));
      existing = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      db = { version: 1, reviews: [], guests: {}, outbound: [] };
    }
    try { secret = await fs.readFile(keyFile, "utf8"); }
    catch (error) {
      if (error.code !== "ENOENT" || existing) throw error;
      secret = crypto.randomBytes(32).toString("hex");
      try { await fs.writeFile(keyFile, secret, { flag: "wx", mode: 0o600 }); }
      catch (writeError) {
        if (writeError.code !== "EEXIST") throw writeError;
        secret = await fs.readFile(keyFile, "utf8");
      }
    }
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("Invalid cookie signing key");
    if (!existing) await atomicWrite(databaseFile, db);
  }

  function signature(visitorId) {
    return crypto.createHmac("sha256", secret).update(visitorId).digest("hex");
  }

  function visitorFromCookie(req) {
    const matches = String(req.headers.cookie || "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${COOKIE_NAME}=`));
    if (matches.length !== 1) return null;
    const match = matches[0].slice(COOKIE_NAME.length + 1).match(/^([a-f0-9]{64})\.([a-f0-9]{64})$/);
    if (!match) return null;
    const [, visitorId, signed] = match;
    return crypto.timingSafeEqual(Buffer.from(signed, "hex"), Buffer.from(signature(visitorId), "hex")) ? visitorId : null;
  }

  function setGuestCookie(req, res, visitorId) {
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${visitorId}.${signature(visitorId)}; Path=/api/framepick; HttpOnly; SameSite=Lax; Max-Age=31536000${req.socket.encrypted ? "; Secure" : ""}`);
  }

  function publicReview(review, visitorId) {
    return { id: review.id, nickname: review.nickname, text: review.text, rating: review.rating,
      createdAt: review.createdAt, updatedAt: review.updatedAt, isMine: review.visitorId === visitorId };
  }

  function stats(reviews) {
    const rated = reviews.filter(review => review.rating !== null);
    return { averageRating: rated.length ? Math.round(rated.reduce((sum, review) => sum + review.rating, 0) / rated.length * 100) / 100 : null,
      ratingCount: rated.length };
  }

  function envelope(filmId, visitorId, offset) {
    const reviews = db.reviews.filter(review => review.filmId === filmId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    const mine = reviews.find(review => review.visitorId === visitorId);
    return { reviews: reviews.slice(offset, offset + PAGE_SIZE).map(review => publicReview(review, visitorId)),
      total: reviews.length, ...stats(reviews), yourReview: mine ? publicReview(mine, visitorId) : null };
  }

  function serialize(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  function outboundWindow() {
    const time = clock();
    const day = new Date(time + 8 * 3600000).toISOString().slice(0, 10);
    return { windowStart: new Date(Date.parse(day) - 9 * 86400000).toISOString().slice(0, 10),
      windowEnd: day, updatedAt: new Date(time).toISOString() };
  }

  function outboundSummary() {
    const window = outboundWindow();
    const counts = new Map();
    for (const entry of db.outbound) if (entry.day >= window.windowStart && entry.day <= window.windowEnd) {
      counts.set(entry.filmId, (counts.get(entry.filmId) || 0) + 1);
    }
    return { metric: "outbound-clicks", ...window,
      films: [...films].map(filmId => ({ filmId, outboundClicks: counts.get(filmId) || 0 })) };
  }

  return async function handleReviewRequest(req, res, url) {
    if (url.pathname !== "/api/framepick" && !url.pathname.startsWith("/api/framepick/")) return false;
    res.setHeader("Vary", "Origin");
    try {
      const origin = req.headers.origin;
      const ownOrigin = `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`;
      if (origin && origin !== ownOrigin && origin !== allowedOrigin) throw failure(403, "请求来源不受信任。");
      if (origin && origin === allowedOrigin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
      const writing = req.method === "POST" || req.method === "DELETE";
      if (writing && req.headers["sec-fetch-site"] === "cross-site" && (!origin || origin !== allowedOrigin)) throw failure(403, "不允许跨站提交。");
      const isSession = url.pathname === "/api/framepick/session";
      const isSummary = url.pathname === "/api/framepick/summary";
      const isOutboundSummary = url.pathname === "/api/framepick/outbound/summary";
      const match = url.pathname.match(/^\/api\/framepick\/films\/([^/]+)\/(reviews|outbound)$/);
      const isOutbound = match?.[2] === "outbound";
      const filmId = match ? decodeURIComponent(match[1]) : null;
      if (!isSession && !isSummary && !isOutboundSummary && !match) throw failure(404, "接口不存在。");
      if (match && !films.has(filmId)) throw failure(404, "作品不存在。");
      const methods = isSession || isSummary || isOutboundSummary ? ["GET"] : isOutbound ? ["POST"] : ["GET", "POST", "DELETE"];
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", [...methods, "OPTIONS"].join(", "));
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.writeHead(204); res.end(); return true;
      }
      if (!methods.includes(req.method)) {
        res.setHeader("Allow", [...methods, "OPTIONS"].join(", "));
        throw failure(405, "请求方法不支持。");
      }
      try { await (ready ||= initialize()); }
      catch (_) { throw failure(503, "评价存储不可用，请联系站点维护者。"); }
      const visitorId = visitorFromCookie(req);
      if (isOutboundSummary) { sendJson(res, 200, outboundSummary()); return true; }
      if (isOutbound) {
        if (!visitorId) { req.resume(); throw failure(401, "请先开启访客模式。"); }
        const payload = await readJsonBody(req);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw failure(400, "跳转记录须为 JSON 对象。");
        const counted = await serialize(async () => {
          const window = outboundWindow();
          if (db.outbound.some(entry => entry.visitorId === visitorId && entry.filmId === filmId && entry.day === window.windowEnd)) return false;
          const outbound = db.outbound.filter(entry => entry.day >= window.windowStart && entry.day <= window.windowEnd);
          outbound.push({ visitorId, filmId, day: window.windowEnd });
          const next = { ...db, outbound };
          try { await atomicWrite(databaseFile, next); }
          catch (_) { throw failure(503, "跳转记录保存失败，请稍后重试。"); }
          db = next;
          return true;
        });
        sendJson(res, 200, { counted });
        return true;
      }
      if (isSession) {
        const id = visitorId || crypto.randomBytes(32).toString("hex");
        setGuestCookie(req, res, id);
        sendJson(res, 200, { nickname: db.guests[id]?.nickname || "访客", mode: "guest" });
        return true;
      }
      if (isSummary) {
        sendJson(res, 200, { films: [...films].map(filmId => {
          const reviews = db.reviews.filter(review => review.filmId === filmId);
          return { filmId, ...stats(reviews), commentCount: reviews.filter(review => review.text.trim()).length };
        }) });
        return true;
      }
      const rawOffset = url.searchParams.get("offset") ?? "0";
      if (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset))) throw failure(400, "分页 offset 须为非负整数。");
      const offset = Number(rawOffset);
      if (writing) {
        if (!visitorId) { req.resume(); throw failure(401, "请先开启访客模式。"); }
        const payload = req.method === "POST" ? validatePayload(await readJsonBody(req)) : null;
        await serialize(async () => {
          const now = Date.now();
          const lastWrite = db.guests[visitorId]?.lastWriteAt;
          if (lastWrite !== undefined && now - lastWrite < cooldownMs) {
            res.setHeader("Retry-After", String(Math.max(1, Math.ceil((cooldownMs - (now - lastWrite)) / 1000))));
            throw failure(429, "操作太快，请稍后重试。");
          }
          const next = { ...db, reviews: [...db.reviews], guests: { ...db.guests } };
          const index = next.reviews.findIndex(review => review.filmId === filmId && review.visitorId === visitorId);
          if (payload) {
            const previous = next.reviews[index];
            const review = { id: previous?.id || crypto.randomUUID(), filmId, visitorId, ...payload,
              createdAt: previous?.createdAt || new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
            if (index >= 0) next.reviews[index] = review;
            else next.reviews.push(review);
          } else if (index >= 0) next.reviews.splice(index, 1);
          next.guests[visitorId] = { nickname: payload?.nickname || db.guests[visitorId]?.nickname || "访客", lastWriteAt: now };
          try { await atomicWrite(databaseFile, next); }
          catch (_) { throw failure(503, "评价保存失败，请稍后重试。"); }
          db = next;
        });
      }
      sendJson(res, 200, envelope(filmId, visitorId, offset));
    } catch (error) {
      sendJson(res, error.status || (error instanceof URIError ? 400 : 500), {
        error: error.status ? error.message : error instanceof URIError ? "作品地址无效。" : "评价服务发生错误。",
      });
    }
    return true;
  };
}

module.exports = { createReviewHandler };

if (require.main === module) {
  const handler = createReviewHandler();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      if (!await handler(req, res, url)) sendJson(res, 404, { error: "接口不存在。" });
    } catch (_) { sendJson(res, 400, { error: "请求地址无效。" }); }
  });
  server.requestTimeout = 30000;
  server.listen(Number(process.env.PORT ?? 3001), "127.0.0.1", () => {
    console.log(`Framepick reviews API: http://127.0.0.1:${server.address().port}`);
  });
}

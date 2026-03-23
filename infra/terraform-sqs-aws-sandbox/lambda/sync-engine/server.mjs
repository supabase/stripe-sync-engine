// sync-engine: Node.js HTTP server (ECS Fargate)
// GET  /health  — ALB health check
// POST /read    — takes webhook JSON, generates 3 events with 10s delays, streams NDJSON
// POST /write   — reads chunked NDJSON body, inserts each row into PostgreSQL, streams status
// POST /log     — external stage reporting (Ruby Lambdas report their stages here)
// GET  /events  — query the event log (?prefix=evt_xxx)

import { createServer } from "node:http";
import pg from "pg";

const PORT = parseInt(process.env.PORT || "3000", 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- database ----------

const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || "5432", 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS event_log (
        id SERIAL PRIMARY KEY,
        event_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata JSONB
      )
    `);
  } finally {
    client.release();
  }
}

async function logEvent(eventId, stage, metadata = null) {
  await pool.query(
    "INSERT INTO event_log (event_id, stage, metadata) VALUES ($1, $2, $3)",
    [eventId, stage, metadata ? JSON.stringify(metadata) : null]
  );
}

// ---------- /health ----------

function handleHealth(_req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
}

// ---------- /read ----------

async function handleRead(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");

  res.writeHead(200, { "Content-Type": "application/x-ndjson" });

  const webhookId = body.id || "unknown";

  const eventCount = 3;

  for (let i = 0; i < eventCount; i++) {
    if (i > 0) await sleep(10_000);

    const evt = {
      id: `evt_${webhookId}_${i}`,
      type: body.type || "webhook.received",
      data: body.data || {},
      created_at: new Date().toISOString(),
      sequence: i + 1,
    };

    await logEvent(evt.id, "message.read");
    res.write(JSON.stringify(evt) + "\n");
  }

  res.end();
}

// ---------- /write ----------

async function handleWrite(req, res) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });

  try {
    let buffer = "";
    let inserted = 0;

    for await (const chunk of req) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const record = JSON.parse(trimmed);
        const id = record.id || `unknown_${inserted}`;
        const payload = JSON.stringify(record);

        await pool.query(
          "INSERT INTO webhooks (id, payload, received_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO NOTHING",
          [id, payload]
        );

        await logEvent(id, "message.written");
        inserted++;

        res.write(
          JSON.stringify({
            event_id: id,
            stage: "message.written",
            written_at: new Date().toISOString(),
          }) + "\n"
        );
      }
    }

    // Handle any remaining data in buffer
    const remaining = buffer.trim();
    if (remaining) {
      const record = JSON.parse(remaining);
      const id = record.id || `unknown_${inserted}`;
      const payload = JSON.stringify(record);

      await pool.query(
        "INSERT INTO webhooks (id, payload, received_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO NOTHING",
        [id, payload]
      );

      await logEvent(id, "message.written");
      inserted++;

      res.write(
        JSON.stringify({
          event_id: id,
          stage: "message.written",
          written_at: new Date().toISOString(),
        }) + "\n"
      );
    }

    res.write(JSON.stringify({ done: true, inserted }) + "\n");
  } catch (err) {
    res.write(JSON.stringify({ error: err.message }) + "\n");
  }

  res.end();
}

// ---------- /log ----------

async function handleLog(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());

  await logEvent(body.event_id, body.stage, body.metadata || null);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ logged: true }));
}

// ---------- /events ----------

async function handleEvents(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const eventId = url.searchParams.get("event_id");
  const prefix = url.searchParams.get("prefix");
  const contains = url.searchParams.get("contains");

  let result;
  if (eventId) {
    result = await pool.query(
      "SELECT event_id, stage, logged_at FROM event_log WHERE event_id = $1 ORDER BY logged_at, id",
      [eventId]
    );
  } else if (contains) {
    result = await pool.query(
      "SELECT event_id, stage, logged_at FROM event_log WHERE event_id LIKE '%' || $1 || '%' ORDER BY logged_at, id",
      [contains]
    );
  } else if (prefix) {
    result = await pool.query(
      "SELECT event_id, stage, logged_at FROM event_log WHERE event_id LIKE $1 ORDER BY logged_at, id",
      [prefix + "%"]
    );
  } else {
    result = await pool.query(
      "SELECT event_id, stage, logged_at FROM event_log ORDER BY logged_at DESC, id DESC LIMIT 50"
    );
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.rows, null, 2));
}

// ---------- router ----------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method?.toUpperCase();

  try {
    if (path === "/health" && method === "GET") {
      handleHealth(req, res);
    } else if (path === "/read" && method === "POST") {
      await handleRead(req, res);
    } else if (path === "/write" && method === "POST") {
      await handleWrite(req, res);
    } else if (path === "/log" && method === "POST") {
      await handleLog(req, res);
    } else if (path === "/events" && method === "GET") {
      await handleEvents(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  } catch (err) {
    console.error("Unhandled error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: err.message }) + "\n");
  }
});

initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`sync-engine listening on port ${PORT}`);
  });
}).catch((err) => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});

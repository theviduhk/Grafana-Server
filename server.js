const axios = require("axios");
const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");

/*
|--------------------------------------------------------------------------
| QAT SERVER — FULL
|--------------------------------------------------------------------------
| Modes:
|   1. Team Leader fetch        -> /TL Hourly.json
|   2. Staff ID fetch           -> /QAT2 Output.json
|   3. Project + Task filtered  -> /qat_filtered.json
|   4. Planning                 -> /planning.json
|   5. Project Outflow          -> projectgap Firebase
|   6. Queue Monitor            -> thevindu Firebase
|   7. QAT Cancellations        -> cancellation-7294a Firebase
|        Supports ?tl=<TL_ID> to filter by team.
|--------------------------------------------------------------------------
*/

/* ═══════════════════════════════════════════════════════════════
   GLOBAL CONFIG
   ═══════════════════════════════════════════════════════════════ */
const QUERY_URL =
  "https://monitor-public.trax-cloud.com/api/datasources/proxy/133/bigquery/v2/projects/trax-ortal-prod/queries";

const FIREBASE_URL = "https://qat-output-default-rtdb.firebaseio.com";

const FIREBASE_PATH_TL       = "/TL Hourly.json";
const FIREBASE_PATH_STAFF    = "/QAT2 Output.json";
const FIREBASE_PATH_FILTERED = "/qat_filtered.json";
const FIREBASE_PATH_PLANNING = "/planning.json";

const FIREBASE_OUTFLOW_URL =
  "https://projectgap-4b7d9-default-rtdb.firebaseio.com/project-gaps.json";

/* ─── Mode 7: Cancellations Firebase ─── */
const CANCELLATION_FIREBASE_BASE =
  process.env.CANCELLATION_FIREBASE_BASE ||
  "https://cancellation-7294a-default-rtdb.firebaseio.com";

const CANCELLATION_TODAY_URL =
  `${CANCELLATION_FIREBASE_BASE}/cancellations.json`;

const CANCELLATION_ARCHIVE_URL = (dateStr) =>
  `${CANCELLATION_FIREBASE_BASE}/cancellations-by-date/${dateStr}.json`;

const CANCELLATION_TEAM_URL = (tl, dateStr) =>
  `${CANCELLATION_FIREBASE_BASE}/cancellations-by-tl/${encodeURIComponent(tl)}/${dateStr}.json`;

const CANCELLATION_AUTO_INTERVAL_SEC = Number(
  process.env.CANCELLATION_INTERVAL_SEC ?? 60
);

/* ─── Mode 5: Outflow interval ─── */
const OUTFLOW_AUTO_INTERVAL_SEC = Number(process.env.OUTFLOW_INTERVAL_SEC ?? 10);
const OUTFLOW_MAX_RANGE_DAYS = Number(process.env.OUTFLOW_MAX_RANGE_DAYS ?? 92);
const PREVIOUS_WEEK_MODE = (process.env.PREVIOUS_WEEK_MODE || "calendar").toLowerCase();

/* ─── Mode 6: Queue monitor ─── */
const QUEUE_FIREBASE_URL =
  process.env.QUEUE_FIREBASE_URL ||
  "https://thevindu-8fe8b-default-rtdb.firebaseio.com/queue_monitor.json";

const SERVER_PROJECTS_PATH = "Server Projects";
const SERVER_PROJECTS_URL =
  process.env.SERVER_PROJECTS_URL ||
  `${FIREBASE_URL}/${encodeURIComponent(SERVER_PROJECTS_PATH)}.json`;

const QUEUE_GRAFANA_URL =
  "https://monitor-public.trax-cloud.com/api/datasources/proxy/29/render";

const QUEUE_INTERVAL_SEC = Number(process.env.QUEUE_INTERVAL_SEC ?? 3);
const QUEUE_CONCURRENCY = Math.max(1, Number(process.env.QUEUE_CONCURRENCY ?? 5) || 5);
const QUEUE_HEARTBEAT_SEC = Number(process.env.QUEUE_HEARTBEAT_SEC ?? 60);
const QUEUE_PROJECTS_CACHE_SEC = Number(process.env.QUEUE_PROJECTS_CACHE_SEC ?? 30);

/* ─── Mode 7: Cancel table config ─── */
const CANCELLATION_TABLE =
  process.env.CANCELLATION_TABLE ||
  "trax-retail.backoffice.qat_cancelation_data";

const CANCELLATION_COL = {
  user:      process.env.CANCELLATION_COL_USER      || "user",
  email:     process.env.CANCELLATION_COL_EMAIL     || "email",
  project:   process.env.CANCELLATION_COL_PROJECT   || "project_name",
  task:      process.env.CANCELLATION_COL_TASK      || "task_name",
  probe:     process.env.CANCELLATION_COL_PROBE     || "probe_id",
  scene:     process.env.CANCELLATION_COL_SCENE     || "scene_id",
  reason:    process.env.CANCELLATION_COL_REASON    || "cancel_reason",
  timestamp: process.env.CANCELLATION_COL_TIMESTAMP || "timestamp",
};

const CANCELLATION_TZ_OFFSET_MIN = 330; // Asia/Colombo = UTC+05:30

/* ─── Staff Roster (for TL → team lookup) ─── */
const ROSTER_SHEET_KEY =
  "2PACX-1vRJZoB62ji32WR7xsyQSJS2uDsVftCnumZoCSs4p4GhDTTl8EydzsdY2cXvQyjv_-syEmqaHeyHYZjb";

const ROSTER_CSV_URLS = [
  `https://docs.google.com/spreadsheets/d/e/${ROSTER_SHEET_KEY}/pub?output=csv&sheet=Staff%20roster`,
  `https://docs.google.com/spreadsheets/d/e/${ROSTER_SHEET_KEY}/pub?output=csv`,
];

/* ─── HTML files ─── */
const PLANNING_HTML_PATH      = path.join(__dirname, "planning.html");
const CANCELLATIONS_HTML_PATH = path.join(__dirname, "cancellations.html");

/* ─── Server ─── */
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

/* ─── Default IDs ─── */
const TEAM_LEADERS = [
  "G26658-OTL",
  "G25883-OTL",
  "G22371-OTL",
  "G23179-OTL",
];

/* ─── Sheets ─── */
const STAFF_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=1860286382&output=csv";

const PROJECT_TASK_SHEET_URL = () =>
  `https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=822634964&output=csv&_=${Date.now()}`;

/* ─── Auth ─── */
const AUTH_USER = process.env.AUTH_USER || "admin";
const AUTH_PASS = process.env.AUTH_PASS || "password123";
const GRAFANA_USER = process.env.GRAFANA_USER || "gss.kurunegala@gssintl.biz";
const GRAFANA_PASS = process.env.GRAFANA_PASS || "Gssk@2021";

/* ═══════════════════════════════════════════════════════════════
   CORS
   ═══════════════════════════════════════════════════════════════ */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Accept",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Max-Age": "86400",
};

function setCorsHeaders(res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
}

function authenticate(req) {
  const h = req.headers.authorization;
  if (!h) return false;
  try {
    const b64 = h.split(" ")[1];
    const creds = Buffer.from(b64, "base64").toString("utf8");
    const [u, p] = creds.split(":");
    return u === AUTH_USER && p === AUTH_PASS;
  } catch {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════
   DATE HELPERS
   ═══════════════════════════════════════════════════════════════ */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseYMD(raw) {
  const s = raw ? String(raw).trim() : "";
  if (!s || !DATE_RE.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const chk = new Date(Date.UTC(y, m - 1, d));
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== m - 1 || chk.getUTCDate() !== d) return null;
  return s;
}

function parseDateParam(q) {
  return parseYMD(q && q.date);
}

function todayColombo() {
  const now = new Date();
  return new Date(now.getTime() + CANCELLATION_TZ_OFFSET_MIN * 60000)
    .toISOString()
    .slice(0, 10);
}

function buildDateRangeClause(dateStr) {
  if (dateStr) {
    return `event_timestamp BETWEEN TIMESTAMP('${dateStr} 00:00:00') AND TIMESTAMP('${dateStr} 23:59:59.999999')`;
  }
  return `event_timestamp BETWEEN TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY) AND CURRENT_TIMESTAMP()`;
}

/* ═══════════════════════════════════════════════════════════════
   SQL HELPERS
   ═══════════════════════════════════════════════════════════════ */
function sqlEscape(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function normalizeIdSql(v) {
  return sqlEscape(String(v).trim().toUpperCase());
}

function buildIdMatchSql(column, value) {
  const id = normalizeIdSql(value);
  const col = `UPPER(TRIM(${column}))`;
  return `(${col} = '${id}' OR STARTS_WITH(${col}, '${id}-'))`;
}

/* ═══════════════════════════════════════════════════════════════
   OUTFLOW DATE RANGE RESOLVER
   ═══════════════════════════════════════════════════════════════ */
function todayUTC() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

function addDaysUTC(d, n) {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function ymdUTC(d) {
  return d.toISOString().slice(0, 10);
}

function daysBetweenInclusive(a, b) {
  const A = Date.parse(`${a}T00:00:00Z`);
  const B = Date.parse(`${b}T00:00:00Z`);
  return Math.round((B - A) / 86400000) + 1;
}

function resolveOutflowRange(q) {
  const today = todayUTC();
  const todayStr = ymdUTC(today);
  const range = q.range ? String(q.range).trim().toLowerCase() : "";
  const fromRaw = q.from ? String(q.from).trim() : "";
  const toRaw = q.to ? String(q.to).trim() : "";

  let key, from, to;

  if (fromRaw || toRaw) {
    const f = parseYMD(fromRaw);
    const t = parseYMD(toRaw);
    if (!f || !t) return { error: "from and to must both be valid YYYY-MM-DD dates" };
    key = "custom";
    from = f <= t ? f : t;
    to = f <= t ? t : f;
  } else if (range && range !== "today") {
    if (range === "yesterday") {
      key = "yesterday";
      from = to = ymdUTC(addDaysUTC(today, -1));
    } else if (range === "day_before") {
      key = "day_before";
      from = to = ymdUTC(addDaysUTC(today, -2));
    } else if (range === "last_week") {
      key = "last_week";
      if (PREVIOUS_WEEK_MODE === "rolling") {
        from = ymdUTC(addDaysUTC(today, -7));
        to = ymdUTC(addDaysUTC(today, -1));
      } else {
        const sinceMonday = (today.getUTCDay() + 6) % 7;
        const thisMonday = addDaysUTC(today, -sinceMonday);
        from = ymdUTC(addDaysUTC(thisMonday, -7));
        to = ymdUTC(addDaysUTC(thisMonday, -1));
      }
    } else {
      return { error: "range must be one of: today, yesterday, day_before, last_week" };
    }
  } else if (q.date) {
    const d = parseDateParam(q);
    if (!d) return { error: "date must be a valid YYYY-MM-DD date" };
    key = "date";
    from = to = d;
  } else {
    key = "today";
    from = to = todayStr;
  }

  if (from > todayStr) return { error: "The selected dates are in the future" };
  if (to > todayStr) to = todayStr;

  const span = daysBetweenInclusive(from, to);
  if (span > OUTFLOW_MAX_RANGE_DAYS) {
    return { error: `Range too large (${span} days). Maximum is ${OUTFLOW_MAX_RANGE_DAYS} days` };
  }

  return { key, from, to, isToday: from === todayStr && to === todayStr };
}

/* ═══════════════════════════════════════════════════════════════
   GRAFANA SESSION MANAGER
   ═══════════════════════════════════════════════════════════════ */
let grafanaSession = null;
let loginPromise = null;

async function loginToGrafana() {
  console.log("🔐 Logging into Grafana to get fresh session...");

  const response = await axios.post(
    "https://monitor-public.trax-cloud.com/login",
    { user: GRAFANA_USER, password: GRAFANA_PASS },
    {
      headers: { "Content-Type": "application/json" },
      maxRedirects: 0,
      validateStatus: (s) => s < 400 || s === 401 || s === 403,
      timeout: 30000,
    }
  );

  console.log(`  Login response status: ${response.status}`);

  const setCookie = response.headers["set-cookie"];
  if (setCookie) {
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const c of arr) {
      const m = c.match(/grafana_session=([^;]+)/);
      if (m) {
        grafanaSession = m[1];
        console.log("✅ New Grafana session obtained successfully!");
        return grafanaSession;
      }
    }
  }

  throw new Error("Login successful but grafana_session cookie not found in response.");
}

async function getGrafanaHeaders() {
  if (!grafanaSession) {
    if (!loginPromise) {
      loginPromise = loginToGrafana().finally(() => {
        loginPromise = null;
      });
    }
    await loginPromise;
  }
  return {
    "Content-Type": "application/json",
    Cookie: `grafana_session=${grafanaSession}`,
  };
}

async function grafanaRequest(method, reqUrl, data = null, retryCount = 0) {
  try {
    const headers = await getGrafanaHeaders();
    const config = { headers, timeout: 30000 };
    let resp;
    if (method === "GET") resp = await axios.get(reqUrl, config);
    else if (method === "POST") resp = await axios.post(reqUrl, data, config);
    return resp;
  } catch (e) {
    if (
      e.response &&
      (e.response.status === 401 || e.response.status === 403) &&
      retryCount < 2
    ) {
      console.warn("⚠️ Session expired or invalid. Refreshing Grafana session...");
      grafanaSession = null;
      loginPromise = null;
      return grafanaRequest(method, reqUrl, data, retryCount + 1);
    }
    throw e;
  }
}

/* ═══════════════════════════════════════════════════════════════
   BIGQUERY — poll until job complete
   ═══════════════════════════════════════════════════════════════ */
async function getQueryResults(resultUrl, maxTries = 10) {
  for (let i = 0; i < maxTries; i++) {
    const res = await grafanaRequest("GET", resultUrl);
    if (res.data.jobComplete) return res.data;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("BigQuery job timeout");
}

/* ═══════════════════════════════════════════════════════════════
   ID NORMALIZATION
   ═══════════════════════════════════════════════════════════════ */
function normalizeId(s) {
  return String(s || "")
    .trim()
    .replace(/-(QAQC|OTL|TL)$/i, "")
    .toUpperCase();
}

/* ═══════════════════════════════════════════════════════════════
   STAFF ROSTER
   ═══════════════════════════════════════════════════════════════ */
let rosterCache = { data: null, ts: 0, ttl: 5 * 60 * 1000 };

function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

async function fetchStaffRoster(force = false) {
  const now = Date.now();
  if (!force && rosterCache.data && now - rosterCache.ts < rosterCache.ttl) {
    return rosterCache.data;
  }

  for (const u of ROSTER_CSV_URLS) {
    try {
      console.log(`  📋 Fetching roster: ${u}`);
      const r = await axios.get(u, { timeout: 20000, responseType: "text" });
      const lines = String(r.data || "")
        .split(/\r?\n/)
        .filter((l) => l.trim());
      if (lines.length < 2) continue;

      const rows = [];
      for (const line of lines) {
        const cells = parseCsvLine(line);
        const idx = cells.findIndex((c, i) => i <= 4 && /^G\d+/i.test(c));
        if (idx === -1) continue;
        const qatId = (cells[idx] || "").trim();
        const name = (cells[idx + 1] || "").trim();
        if (!qatId || !/^G\d+/i.test(qatId)) continue;
        if (!name || /^\d+(\.\d+)?$/.test(name)) continue;

        rows.push({
          qatId,
          name,
          primary:   (cells[idx + 2] || "").trim(),
          secondary: (cells[idx + 3] || "").trim(),
          tertiary:  (cells[idx + 4] || "").trim(),
          fourth:    (cells[idx + 5] || "").trim(),
          email:     (cells[idx + 6] || "").trim(),
          teamLead:  (cells[idx + 7] || "").trim(),
          shiftTime: (cells[idx + 8] || "").trim(),
          region:    (cells[idx + 9] || "").trim(),
          shiftSup:  (cells[idx + 10] || "").trim(),
        });
      }

      if (rows.length > 0) {
        console.log(`  ✅ Roster loaded: ${rows.length} rows`);
        rosterCache = { data: rows, ts: Date.now(), ttl: rosterCache.ttl };
        return rows;
      }
    } catch (e) {
      console.warn(`  ⚠️ Roster fetch failed: ${e.message}`);
    }
  }

  console.warn("  ⚠️ Roster unavailable");
  return rosterCache.data || [];
}

/* ═══════════════════════════════════════════════════════════════
   TL → TEAM LOOKUP
   ═══════════════════════════════════════════════════════════════ */
function findTeamForTL(roster, tlInput) {
  const tlNorm = normalizeId(tlInput);
  if (!tlNorm || tlNorm === "ADMIN") return [];

  const idSet = new Set([tlNorm]);

  // find TL's own row for name variations
  const tlRow = roster.find((r) => normalizeId(r.qatId) === tlNorm);
  if (tlRow) {
    const name = String(tlRow.name || "").trim().toUpperCase();
    if (name) {
      idSet.add(name);
      name.split(/\s+/).forEach((w) => w.length >= 3 && idSet.add(w));
    }
  }

  const ids = Array.from(idSet).filter((x) => x && x.length >= 3);

  return roster.filter((row) => {
    const rowTL = String(row.teamLead || "").trim().toUpperCase();
    if (!rowTL) return false;
    return ids.some(
      (id) => rowTL === id || rowTL.includes(id) || id.includes(rowTL)
    );
  });
}

/* ═══════════════════════════════════════════════════════════════
   SQL BUILDERS — Modes 1–5
   ═══════════════════════════════════════════════════════════════ */
function buildQueryByTeamLeader(tlName, dateStr) {
  const idMatch = buildIdMatchSql("team_leader_staff_id", tlName);
  const dateClause = buildDateRangeClause(dateStr);
  return {
    query: `
      #standardSQL
      SELECT
        TIMESTAMP_TRUNC(event_timestamp, HOUR) AS timestamp,
        project_name,
        task_name,
        staff_id,
        template_name,
        SUM(CASE WHEN LOWER(TRIM(task_name)) = 'stitching' THEN number_of_probes ELSE count END) AS value
      FROM \`trax-retail.backoffice.tl_hourly_report\`
      WHERE ${dateClause}
        AND task_name IS NOT NULL
        AND project_name IS NOT NULL
        AND ${idMatch}
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY timestamp
    `,
    useLegacySql: false,
  };
}

function buildQueryByStaffId(staffId, dateStr) {
  const idMatch = buildIdMatchSql("staff_id", staffId);
  const dateClause = buildDateRangeClause(dateStr);
  return {
    query: `
      #standardSQL
      SELECT
        TIMESTAMP_TRUNC(event_timestamp, HOUR) AS timestamp,
        project_name,
        task_name,
        staff_id,
        template_name,
        SUM(CASE WHEN LOWER(TRIM(task_name)) = 'stitching' THEN number_of_probes ELSE count END) AS value
      FROM \`trax-retail.backoffice.tl_hourly_report\`
      WHERE ${dateClause}
        AND task_name IS NOT NULL
        AND project_name IS NOT NULL
        AND ${idMatch}
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY timestamp
    `,
    useLegacySql: false,
  };
}

function buildQueryByProjectTask(project, task, dateStr) {
  const sp = sqlEscape(project);
  const st = sqlEscape(task);
  const dateClause = buildDateRangeClause(dateStr);
  return {
    query: `
      #standardSQL
      SELECT
        TIMESTAMP_TRUNC(event_timestamp, HOUR) AS timestamp,
        project_name,
        task_name,
        staff_id,
        template_name,
        SUM(count) AS value
      FROM \`trax-retail.backoffice.tl_hourly_report\`
      WHERE ${dateClause}
        AND task_name IS NOT NULL
        AND project_name = '${sp}'
        AND task_name    = '${st}'
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY timestamp
    `,
    useLegacySql: false,
  };
}

function buildQueryOutflow(fromStr, toStr) {
  let dc;
  if (fromStr && toStr) {
    dc =
      fromStr === toStr
        ? `DATE(event_timestamp) = DATE('${fromStr}')`
        : `DATE(event_timestamp) BETWEEN DATE('${fromStr}') AND DATE('${toStr}')`;
  } else {
    dc = `DATE(event_timestamp) = CURRENT_DATE()`;
  }
  return {
    query: `
      #standardSQL
      SELECT project_name, task_name, center, SUM(count) AS value
      FROM \`trax-retail.backoffice.560_project_outflow\`
      WHERE ${dc}
      GROUP BY 1, 2, 3
      ORDER BY value DESC
    `,
    useLegacySql: false,
  };
}

/* ═══════════════════════════════════════════════════════════════
   MODE 7 SQL — Cancellations
   ═══════════════════════════════════════════════════════════════
   userIds (optional array): when provided, only rows where `user`
   matches one of those IDs (or ID + "-SUFFIX") are returned.
   This is how TL-scoped filtering works.
   ═══════════════════════════════════════════════════════════════ */
function buildQueryCancellations(dateStr, userIds) {
  const C = CANCELLATION_COL;

  let userFilter = "";

  if (Array.isArray(userIds)) {
    const ids = [...new Set(userIds.map(normalizeId).filter(Boolean))]
      .filter((x) => x && x !== "ADMIN" && x !== "UNKNOWN");

    if (ids.length === 0) {
      // team resolved to empty → return nothing
      return {
        query: `
          #standardSQL
          SELECT
            \`${C.user}\` AS user,
            SPLIT(${C.email}, '@')[OFFSET(0)] AS employee_name,
            ${C.project} AS project_name,
            ${C.task} AS task_name,
            CAST(${C.probe} AS STRING) AS probe_scene,
            ${C.reason} AS cancel_reason,
            UNIX_MILLIS(TIMESTAMP(${C.timestamp})) AS timestamp
          FROM \`${CANCELLATION_TABLE}\`
          WHERE FALSE
        `,
        useLegacySql: false,
      };
    }

    if (ids.length <= 500) {
      const inList = ids.map((id) => `'${sqlEscape(id)}'`).join(", ");
      const likeClauses = ids
        .map((id) => `UPPER(TRIM(\`${C.user}\`)) LIKE '${sqlEscape(id)}-%'`)
        .join(" OR ");
      userFilter = `AND (UPPER(TRIM(\`${C.user}\`)) IN (${inList}) OR ${likeClauses})`;
    } else {
      console.warn(`  ⚠️ Team has ${ids.length} IDs — skipping user filter`);
    }
  }

  return {
    query: `
      #standardSQL
      SELECT
        \`${C.user}\` AS user,
        SPLIT(${C.email}, '@')[OFFSET(0)] AS employee_name,
        ${C.project} AS project_name,
        ${C.task} AS task_name,
        CAST(${C.probe} AS STRING) AS probe_scene,
        ${C.reason} AS cancel_reason,
        UNIX_MILLIS(TIMESTAMP(${C.timestamp})) AS timestamp
      FROM \`${CANCELLATION_TABLE}\`
      WHERE ${C.timestamp} = DATE('${dateStr}')
        ${userFilter}
      ORDER BY \`${C.user}\`
      LIMIT 10000
    `,
    useLegacySql: false,
  };
}

/* ═══════════════════════════════════════════════════════════════
   TEMPLATE-NAME TASK LOOKUP
   ═══════════════════════════════════════════════════════════════ */
const normKeySimple = (s) =>
  (s || "").toLowerCase().trim().replace(/\s+/g, " ");

const TEMPLATE_NAME_TASKS = new Set([
  "voting_engine",
  "offline_validation",
  "voting",
  "validation",
  "offline_voting",
]);

function isTemplateNameTask(taskName) {
  return TEMPLATE_NAME_TASKS.has(normKeySimple(taskName));
}

/* ═══════════════════════════════════════════════════════════════
   PROCESS ROWS
   ═══════════════════════════════════════════════════════════════ */
function processResults(result) {
  if (!result.rows) return [];
  const fields = result.schema.fields.map((f) => f.name);
  return result.rows
    .map((row) => {
      const o = {};
      row.f.forEach((c, i) => {
        o[fields[i]] = c.v;
      });
      return o;
    })
    .filter((o) => {
      const s = String(o.staff_id || "").trim().toLowerCase();
      return s !== "" && s !== "auto_stitch";
    })
    .map((o) => {
      const r = {
        timestamp: o.timestamp || "",
        project_name: o.project_name || "",
        task_name: o.task_name || "",
        staff_id: o.staff_id || "",
        value: Number(o.value || 0),
      };
      const isPges = normKeySimple(o.project_name) === "pges";
      const isUFPriority = UF_PRIORITY_PROJECTS.has(normKeySimple(o.project_name));
      if ((isTemplateNameTask(o.task_name) || isPges || isUFPriority) && o.template_name) {
        r.template_name = o.template_name;
      }
      return r;
    });
}

function processOutflowResults(result) {
  if (!result.rows) return [];
  const fields = result.schema.fields.map((f) => f.name);
  return result.rows.map((row) => {
    const o = {};
    row.f.forEach((c, i) => {
      o[fields[i]] = c.v;
    });
    return {
      project: o.project_name || "N/A",
      task: o.task_name || "N/A",
      center: o.center || "N/A",
      value: Number(o.value || 0),
    };
  });
}

function processCancellationResults(result) {
  if (!result.rows) return [];
  const fields = result.schema.fields.map((f) => f.name);
  return result.rows.map((row) => {
    const o = {};
    row.f.forEach((c, i) => {
      o[fields[i]] = c.v;
    });
    return {
      user:          String(o.user || "").trim(),
      employee_name: String(o.employee_name || "").trim(),
      project_name:  String(o.project_name || "").trim(),
      task_name:     String(o.task_name || "").trim(),
      probe_scene:   String(o.probe_scene || "").trim(),
      cancel_reason: String(o.cancel_reason || "").trim(),
      timestamp:     Number(o.timestamp || 0),
    };
  });
}

/* ═══════════════════════════════════════════════════════════════
   FIREBASE SAVE / READ
   ═══════════════════════════════════════════════════════════════ */
async function saveToFirebase(p, payload) {
  await axios.put(`${FIREBASE_URL}${p}`, payload);
  console.log(`  🔥 Firebase updated at "${p}"`);
}

async function getFromFirebase(p) {
  try {
    const r = await axios.get(`${FIREBASE_URL}${p}`);
    return r.data || null;
  } catch (e) {
    console.error(`  🔥 Firebase read error (${p}):`, e.message);
    return null;
  }
}

async function saveOutflowToFirebase(payload) {
  await axios.put(FIREBASE_OUTFLOW_URL, payload, { timeout: 30000 });
  console.log("  🔥 Outflow Firebase updated");
}

async function saveCancellationsTodayToFirebase(payload) {
  await axios.put(CANCELLATION_TODAY_URL, payload, { timeout: 30000 });
  console.log(`  🔥 Cancellations saved /cancellations.json (${payload.date})`);
}

async function saveCancellationsDateToFirebase(d, payload) {
  await axios.put(CANCELLATION_ARCHIVE_URL(d), payload, { timeout: 30000 });
  console.log(`  🔥 Cancellations archived /cancellations-by-date/${d}.json`);
}

async function saveCancellationsTeamToFirebase(tl, d, payload) {
  await axios.put(CANCELLATION_TEAM_URL(tl, d), payload, { timeout: 30000 });
  console.log(`  🔥 Cancellations team-saved /cancellations-by-tl/${tl}/${d}.json`);
}

/* ═══════════════════════════════════════════════════════════════
   DENOMINATOR LOOKUP
   ═══════════════════════════════════════════════════════════════ */
const normKey = (s) => (s || "").toLowerCase().trim().replace(/\s+/g, " ");

const UF_PRIORITY_PROJECTS = new Set(
  [
    "batru",
    "diageopl", "diageoes", "diageopebac", "diageoromania", "aneuae",
    "rjreynoldsus", "diageomx", "diageobenelux", "diageoga", "diageoza",
    "diageoug", "diageoca", "diageouk", "diageoit", "diageoco", "diageotz",
    "frucorau", "diageogr", "diageoin", "diageoie", "diageoar", "diageoke",
    "diageostr", "diageogtr",
  ].map(normKey)
);

const TASK_EQUIV_GROUPS = {
  voting: ["voting", "offline_voting"],
  offline_voting: ["voting", "offline_voting"],
  validation: ["validation", "offline_validation"],
  offline_validation: ["validation", "offline_validation"],
};

function taskEquivalents(task) {
  const t = normKey(task);
  return TASK_EQUIV_GROUPS[t] || [t];
}

function ufKey(project, task, subtask) {
  return `${normKey(project)}||${normKey(task)}||${normKey(subtask)}`;
}

const NON_TASK_HEADERS = new Set(["vlookup", "region"]);
const UF_COL_PROJECT = 26;
const UF_COL_TASK = 27;
const UF_COL_SUBTASK = 28;
const UF_COL_DENOMINATOR = 29;

let denominatorCache = {
  data: null,
  timestamp: null,
  cacheDuration: 5 * 60 * 1000,
};

async function fetchDenominatorSheet() {
  try {
    console.log("📊 Fetching denominator matrix...");
    const r = await axios.get(PROJECT_TASK_SHEET_URL(), {
      responseType: "text",
      timeout: 30000,
    });

    const lines = r.data.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 3) {
      return { byProjectTask: {}, byGID: {}, rows: [], uf: {}, ufRowsByProject: {} };
    }

    const splitLine = (l) =>
      l.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));

    const hdr = splitLine(lines[1]);
    let mainEnd = hdr.length;
    for (let c = 1; c < hdr.length; c++) {
      const h = normKey(hdr[c]);
      if (!h || NON_TASK_HEADERS.has(h)) {
        mainEnd = c;
        break;
      }
    }
    const taskNames = hdr.slice(1, mainEnd).map(normKey);

    const m = {
      byProjectTask: {},
      byGID: {},
      rows: [],
      uf: {},
      ufRowsByProject: {},
    };

    for (let i = 2; i < lines.length; i++) {
      const cells = splitLine(lines[i]);

      const p = normKey(cells[0] || "");
      if (p) {
        for (let j = 1; j <= taskNames.length; j++) {
          const t = taskNames[j - 1];
          if (!t) continue;
          const raw = (cells[j] || "").trim();
          if (!raw || raw === "-") continue;
          const d = parseFloat(raw);
          if (isNaN(d)) continue;
          m.byProjectTask[`${p}||${t}`] = d;
          m.rows.push({ project: p, task: t, denominator: d });
        }
      }

      const ufp = (cells[UF_COL_PROJECT] || "").trim();
      const uft = (cells[UF_COL_TASK] || "").trim();
      const ufs = (cells[UF_COL_SUBTASK] || "").trim();
      const ufd = (cells[UF_COL_DENOMINATOR] || "").trim();
      if (ufp && uft && ufs && ufd && ufd !== "-") {
        const d = parseFloat(ufd);
        if (!isNaN(d)) {
          const np = normKey(ufp);
          const nt = normKey(uft);
          const ns = normKey(ufs);
          m.uf[ufKey(ufp, uft, ufs)] = d;
          if (!m.ufRowsByProject[np]) m.ufRowsByProject[np] = [];
          m.ufRowsByProject[np].push({ task: nt, subtask: ns, denominator: d });
        }
      }
    }

    console.log(
      `✅ Denom loaded: ${Object.keys(m.byProjectTask).length} PT, ${Object.keys(m.uf).length} UF`
    );
    return m;
  } catch (e) {
    console.error("❌ Denominator fetch:", e.message);
    return { byProjectTask: {}, byGID: {}, rows: [], uf: {}, ufRowsByProject: {} };
  }
}

async function getDenominatorData(force = false) {
  const now = Date.now();
  if (
    !force &&
    denominatorCache.data &&
    denominatorCache.timestamp &&
    now - denominatorCache.timestamp < denominatorCache.cacheDuration
  ) {
    return denominatorCache.data;
  }
  const d = await fetchDenominatorSheet();
  denominatorCache.data = d;
  denominatorCache.timestamp = now;
  return d;
}

const TASK_FALLBACK_035 = new Set([
  "offline_posm", "posm_masking", "posm_voting",
  "stitching", "stitching_edit",
  "scene_recognition", "scene_recognition_edit",
  "validation_warm_up",
]);

const TASK_FALLBACK_1 = new Set([
  "category_expert", "voting_engine", "masking", "masking_engine",
  "masking_menu_items", "masking_price_labels", "offline_pricing",
  "pricing_voting", "special_masking", "validation", "validation_edit",
  "offline_validation", "voting", "offline_voting",
]);

function taskFallback(t) {
  if (TASK_FALLBACK_035.has(t)) return 0.35;
  if (TASK_FALLBACK_1.has(t)) return 1;
  return 0;
}

function findUFDenominator(p, t, ufRowsByProject) {
  const rows = ufRowsByProject[normKey(p)];
  if (!rows || !rows.length) return undefined;
  const nt = normKey(t);
  const eq = new Set(taskEquivalents(t));
  let exM, exA, eM, eA;
  for (const r of rows) {
    if (r.task === nt) {
      if (r.subtask === "menu") exM = r.denominator;
      else if (exA === undefined) exA = r.denominator;
    } else if (eq.has(r.task)) {
      if (r.subtask === "menu") eM = r.denominator;
      else if (eA === undefined) eA = r.denominator;
    }
  }
  if (exM !== undefined) return exM;
  if (exA !== undefined) return exA;
  if (eM !== undefined) return eM;
  if (eA !== undefined) return eA;
  return undefined;
}

function findUFDenBySubtask(p, t, s, ufRowsByProject) {
  const rows = ufRowsByProject[normKey(p)];
  if (!rows || !rows.length) return undefined;
  const nt = normKey(t);
  const ns = normKey(s);
  const eq = new Set(taskEquivalents(t));
  let ex, ev;
  for (const r of rows) {
    if (r.subtask !== ns) continue;
    if (r.task === nt) ex = r.denominator;
    else if (eq.has(r.task) && ev === undefined) ev = r.denominator;
  }
  return ex !== undefined ? ex : ev;
}

function findUFDenByTaskAsSubtask(p, t, ufRowsByProject) {
  const rows = ufRowsByProject[normKey(p)];
  if (!rows || !rows.length) return undefined;
  const nt = normKey(t);
  const eq = new Set(taskEquivalents(t));
  let ex, ev;
  for (const r of rows) {
    if (r.subtask === nt) ex = r.denominator;
    else if (eq.has(r.subtask) && ev === undefined) ev = r.denominator;
  }
  return ex !== undefined ? ex : ev;
}

function lookupDenominator(p, t, dd, tpl) {
  const np = normKey(p);
  const nt = normKey(t);
  const uf = dd.ufRowsByProject || {};

  if (np === "pges") {
    const s = normKey(tpl).includes("display")
      ? "Repair Only"
      : "Repair & Attribute";
    const v = findUFDenBySubtask(np, nt, s, uf);
    if (v !== undefined) return v;
  } else if (UF_PRIORITY_PROJECTS.has(np)) {
    const tn = normKey(tpl);
    let uiSub = null;
    if (tn.includes("menu")) uiSub = "Menu";
    else if (tn.includes("posm")) uiSub = "offline_posm";

    if (uiSub) {
      const v = findUFDenBySubtask(np, nt, uiSub, uf);
      if (v !== undefined) return v;
    } else {
      const v = findUFDenByTaskAsSubtask(np, nt, uf);
      if (v !== undefined) return v;
    }

    const v = findUFDenominator(np, nt, uf);
    if (v !== undefined) return v;
  }

  const key = `${np}||${nt}`;
  if (dd.byProjectTask[key] !== undefined) return dd.byProjectTask[key];
  return taskFallback(nt);
}

async function enrichWithDenominator(rows) {
  const dd = await getDenominatorData();
  return rows.map((r) => {
    const d = lookupDenominator(r.project_name, r.task_name, dd, r.template_name);
    return { ...r, denominator: d, wd: r.value * d, count: r.value };
  });
}

/* ═══════════════════════════════════════════════════════════════
   MODE 1: TEAM LEADER
   ═══════════════════════════════════════════════════════════════ */
async function fetchSingleTL(tl, dateStr) {
  console.log(`  [TL] "${tl}" date="${dateStr || "today"}"`);
  const q = buildQueryByTeamLeader(tl, dateStr);
  const r = await grafanaRequest("POST", QUERY_URL, q);
  const { jobId, location } = r.data.jobReference;
  const url2 = `${QUERY_URL}/${jobId}?location=${location}`;
  const result = await getQueryResults(url2);
  let rows = processResults(result);
  rows = await enrichWithDenominator(rows);
  console.log(`    ${rows.length} rows`);
  return {
    tl_name: tl,
    rows,
    total_rows: rows.length,
    fetched_at: new Date().toISOString(),
  };
}

async function fetchAllTeamLeaders(list, dateStr) {
  const tls = list && list.length ? list : TEAM_LEADERS;
  console.log(`\n>>> [TL] Fetching ${tls.length} TLs... date="${dateStr || "today"}"`);
  const results = await Promise.all(
    tls.map(async (tl) => {
      try {
        return await fetchSingleTL(tl, dateStr);
      } catch (e) {
        console.error(`  Error fetching ${tl}:`, e.message);
        return {
          tl_name: tl,
          error: e.message,
          rows: [],
          total_rows: 0,
          fetched_at: new Date().toISOString(),
        };
      }
    })
  );
  return results;
}

/* ═══════════════════════════════════════════════════════════════
   MODE 2: STAFF ID
   ═══════════════════════════════════════════════════════════════ */
async function fetchSingleStaff(sid, dateStr) {
  console.log(`  [STAFF] "${sid}" date="${dateStr || "today"}"`);
  const q = buildQueryByStaffId(sid, dateStr);
  const r = await grafanaRequest("POST", QUERY_URL, q);
  const { jobId, location } = r.data.jobReference;
  const url2 = `${QUERY_URL}/${jobId}?location=${location}`;
  const result = await getQueryResults(url2);
  let rows = processResults(result);
  rows = await enrichWithDenominator(rows);
  console.log(`    ${rows.length} rows`);
  return {
    staff_id: sid,
    rows,
    total_rows: rows.length,
    fetched_at: new Date().toISOString(),
  };
}

async function fetchAllStaff(ids, dateStr) {
  const list = ids && ids.length ? ids : TEAM_LEADERS;
  console.log(`\n>>> [STAFF] Fetching ${list.length} staff... date="${dateStr || "today"}"`);
  const results = await Promise.all(
    list.map(async (sid) => {
      try {
        return await fetchSingleStaff(sid, dateStr);
      } catch (e) {
        console.error(`  Error fetching ${sid}:`, e.message);
        return {
          staff_id: sid,
          error: e.message,
          rows: [],
          total_rows: 0,
          fetched_at: new Date().toISOString(),
        };
      }
    })
  );
  return results;
}

/* ═══════════════════════════════════════════════════════════════
   MODE 3: FILTERED
   ═══════════════════════════════════════════════════════════════ */
async function fetchFilteredByProjectTask(p, t, dateStr) {
  console.log(`\n[FILTERED] "${p}" / "${t}" date="${dateStr || "today"}"`);
  const q = buildQueryByProjectTask(p, t, dateStr);
  const r = await grafanaRequest("POST", QUERY_URL, q);
  const { jobId, location } = r.data.jobReference;
  const url2 = `${QUERY_URL}/${jobId}?location=${location}`;
  const result = await getQueryResults(url2);
  const rows = processResults(result);
  console.log(`  ${rows.length} rows`);
  return rows;
}

/* ═══════════════════════════════════════════════════════════════
   MODE 4: PLANNING
   ═══════════════════════════════════════════════════════════════ */
async function fetchPlanningActual(entry, dateStr) {
  const rows = await fetchFilteredByProjectTask(
    entry.project_name,
    entry.task_name,
    dateStr
  );
  const actual = rows.reduce((s, r) => s + (Number(r.value) || 0), 0);
  const target = Number(entry.target) || 0;
  const percentage = target > 0 ? Math.round((actual / target) * 1000) / 10 : 0;

  const sm = {};
  rows.forEach((r) => {
    const id = r.staff_id || "unknown";
    sm[id] = (sm[id] || 0) + (Number(r.value) || 0);
  });
  const staff_breakdown = Object.entries(sm)
    .map(([staff_id, value]) => ({ staff_id, value }))
    .sort((a, b) => b.value - a.value);

  return { actual, percentage, staff_breakdown };
}

async function refreshAllPlanning(dateStr) {
  const map = (await getFromFirebase(FIREBASE_PATH_PLANNING)) || {};
  const ids = Object.keys(map);
  console.log(`\n>>> [PLANNING] Refreshing ${ids.length} items... date="${dateStr || "today"}"`);

  const updated = {};
  await Promise.all(
    ids.map(async (id) => {
      const entry = map[id] || {};
      try {
        const { actual, percentage, staff_breakdown } = await fetchPlanningActual(entry, dateStr);
        updated[id] = {
          ...entry,
          actual,
          percentage,
          staff_breakdown,
          date: dateStr || "today",
          last_fetched_at: new Date().toISOString(),
        };
      } catch (e) {
        console.error(`  Error refreshing planning id=${id}:`, e.message);
        updated[id] = {
          ...entry,
          error: e.message,
          last_fetched_at: new Date().toISOString(),
        };
      }
    })
  );

  await saveToFirebase(FIREBASE_PATH_PLANNING, updated);
  return updated;
}

/* ═══════════════════════════════════════════════════════════════
   MODE 5: OUTFLOW
   ═══════════════════════════════════════════════════════════════ */
async function fetchOutflow(fromStr, toStr) {
  const lbl = fromStr && toStr
    ? fromStr === toStr
      ? fromStr
      : `${fromStr}..${toStr}`
    : "today";
  console.log(`\n[OUTFLOW] "${lbl}"`);
  const q = buildQueryOutflow(fromStr, toStr);
  const r = await grafanaRequest("POST", QUERY_URL, q);
  const { jobId, location } = r.data.jobReference;
  const url2 = `${QUERY_URL}/${jobId}?location=${location}`;

  const isMultiDay = !!(fromStr && toStr && fromStr !== toStr);
  let result = await getQueryResults(url2, isMultiDay ? 30 : 10);
  let rows = processOutflowResults(result);

  let pt = result.pageToken;
  let pages = 1;
  while (pt && pages < 50) {
    const pr = await grafanaRequest(
      "GET",
      `${url2}&pageToken=${encodeURIComponent(pt)}`
    );
    result = pr.data;
    rows = rows.concat(processOutflowResults(result));
    pt = result.pageToken;
    pages++;
  }

  console.log(`  ${rows.length} rows`);
  return rows;
}

let outflowRunning = false;

async function refreshOutflow() {
  const rows = await fetchOutflow(null, null);
  const payload = {
    lastUpdated: new Date().toISOString(),
    date: "today",
    total_rows: rows.length,
    data: rows,
  };
  await saveOutflowToFirebase(payload);
  return payload;
}

async function autoRefreshOutflowOnce() {
  if (outflowRunning) {
    console.log("  ⏭️ [OUTFLOW] Previous refresh still running, skipping");
    return;
  }
  outflowRunning = true;
  try {
    await refreshOutflow();
    console.log("✅ [OUTFLOW] Updated:", new Date().toLocaleTimeString());
  } catch (e) {
    console.error("❌ [OUTFLOW] Auto refresh error:", e.message);
  } finally {
    outflowRunning = false;
  }
}

function startOutflowAutoLoop() {
  if (!OUTFLOW_AUTO_INTERVAL_SEC || OUTFLOW_AUTO_INTERVAL_SEC <= 0) {
    console.log("  ⏸️ [OUTFLOW] Auto refresh disabled");
    return;
  }
  const loop = async () => {
    await autoRefreshOutflowOnce();
    setTimeout(loop, OUTFLOW_AUTO_INTERVAL_SEC * 1000);
  };
  loop();
}

/* ═══════════════════════════════════════════════════════════════
   MODE 7: CANCELLATIONS
   ═══════════════════════════════════════════════════════════════ */
async function fetchCancellations(dateStr, userIds) {
  console.log(
    `\n>>> [CANCELLATIONS] date="${dateStr}"${
      userIds ? `, filter=${userIds.length} users` : " (all)"
    }`
  );
  const q = buildQueryCancellations(dateStr, userIds);
  const r = await grafanaRequest("POST", QUERY_URL, q);
  const { jobId, location } = r.data.jobReference;
  const url2 = `${QUERY_URL}/${jobId}?location=${location}`;

  let result = await getQueryResults(url2, 15);
  let rows = processCancellationResults(result);

  let pt = result.pageToken;
  let pages = 1;
  while (pt && pages < 20) {
    const pr = await grafanaRequest(
      "GET",
      `${url2}&pageToken=${encodeURIComponent(pt)}`
    );
    result = pr.data;
    rows = rows.concat(processCancellationResults(result));
    pt = result.pageToken;
    pages++;
  }

  console.log(`  ${rows.length} rows`);
  return rows;
}

let cancellationRunning = false;

async function refreshCancellations() {
  const d = todayColombo();
  const rows = await fetchCancellations(d, null);
  const payload = {
    lastUpdated: new Date().toISOString(),
    date: d,
    timezone: "Asia/Colombo",
    total_rows: rows.length,
    data: rows,
  };
  await saveCancellationsTodayToFirebase(payload);
  await saveCancellationsDateToFirebase(d, payload);
  return payload;
}

async function autoRefreshCancellationsOnce() {
  if (cancellationRunning) {
    console.log("  ⏭️ [CANCELLATIONS] Previous refresh still running, skipping");
    return;
  }
  cancellationRunning = true;
  try {
    await refreshCancellations();
    console.log("✅ [CANCELLATIONS] Updated:", new Date().toLocaleTimeString());
  } catch (e) {
    console.error("❌ [CANCELLATIONS] Auto refresh error:", e.message);
  } finally {
    cancellationRunning = false;
  }
}

function startCancellationsAutoLoop() {
  if (!CANCELLATION_AUTO_INTERVAL_SEC || CANCELLATION_AUTO_INTERVAL_SEC <= 0) {
    console.log("  ⏸️ [CANCELLATIONS] Auto refresh disabled");
    return;
  }
  const loop = async () => {
    await autoRefreshCancellationsOnce();
    setTimeout(loop, CANCELLATION_AUTO_INTERVAL_SEC * 1000);
  };
  loop();
}

/* ═══════════════════════════════════════════════════════════════
   MODE 6: QUEUE MONITOR
   ═══════════════════════════════════════════════════════════════ */
const QUEUE_METRICS = [
  { path: "validation", name: "validation" },
  { path: "offline_posm", name: "offline posm" },
  { path: "voting", name: "voting" },
  { path: "stitching", name: "stitching" },
  { path: "Pricing_voting", name: "Pricing voting" },
  { path: "offline_pricing", name: "offline pricing" },
  { path: "Offline_Pricing_Voting", name: "Pricing voting" },
  { path: "scene_recognition", name: "scene recognition" },
  { path: "category_expert", name: "category expert" },
  { path: "offline_validation", name: "offline validation" },
  { path: "pricing_voting", name: "Pricing voting" },
  { path: "voting_engine", name: "Engine Voting" },
  { path: "offline_voting", name: "offline voting" },
];

const QUEUE_PROJECT_NAME_RE = /^[a-z0-9_-]+$/;

function formatDuration(sec) {
  sec = Math.floor(Number(sec));
  if (isNaN(sec)) return null;
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return `${h}h ${mm}m`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  if (d < 7) return `${d}d ${hh}h`;
  return `${Math.floor(d / 7)}w ${d % 7}d`;
}

async function grafanaRender(body, retryCount = 0) {
  let used = null;
  try {
    const headers = await getGrafanaHeaders();
    used = grafanaSession;
    const res = await axios.post(QUEUE_GRAFANA_URL, body, {
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30000,
    });
    if (!Array.isArray(res.data)) {
      const e = new Error("Unexpected Grafana render response");
      e.badSession = true;
      throw e;
    }
    return res.data;
  } catch (e) {
    const st = e.response && e.response.status;
    const expired = st === 401 || st === 403 || e.badSession;
    if (expired && retryCount < 2) {
      console.warn("⚠️ [QUEUE] Session expired, refreshing...");
      if (grafanaSession === used) grafanaSession = null;
      return grafanaRender(body, retryCount + 1);
    }
    throw e;
  }
}

let queueProjectsCache = { list: [], ts: 0 };
const queueWarnedNames = new Set();

async function getQueueProjects(force = false) {
  const now = Date.now();
  if (
    !force &&
    queueProjectsCache.ts &&
    now - queueProjectsCache.ts < QUEUE_PROJECTS_CACHE_SEC * 1000
  ) {
    return queueProjectsCache.list;
  }

  const res = await axios.get(SERVER_PROJECTS_URL, { timeout: 30000 });
  const data = res.data;
  const names = new Set();

  if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) {
      if (v === null || v === undefined) continue;
      let raw;
      if (typeof v === "string") raw = v;
      else if (typeof v === "object" && v.name) raw = String(v.name);
      else raw = k;

      const name = raw.trim().toLowerCase();
      if (!name) continue;

      if (!QUEUE_PROJECT_NAME_RE.test(name)) {
        if (!queueWarnedNames.has(name)) {
          queueWarnedNames.add(name);
          console.warn(`  ⚠️ [QUEUE] Skipping invalid project name: "${raw}"`);
        }
        continue;
      }
      names.add(name);
    }
  }

  const list = Array.from(names).sort();
  queueProjectsCache = { list, ts: now };
  return list;
}

let queueMirror = null;
const queueLastPush = {};

async function loadQueueMirror() {
  const r = await axios.get(QUEUE_FIREBASE_URL, { timeout: 30000 });
  queueMirror = r.data && typeof r.data === "object" ? r.data : {};
  console.log(`  📥 [QUEUE] Loaded ${Object.keys(queueMirror).length} project(s)`);
}

async function fetchQueueProject(project) {
  const params = new URLSearchParams();
  for (const m of QUEUE_METRICS) {
    params.append(
      "target",
      `alias(prod.gauges.selector.queue.${m.path}.${project}.total,'${m.name} - Total')`
    );
    params.append(
      "target",
      `alias(aliasByNode(prod.gauges.selector.queue.${m.path}.${project}.oldestTask,4),'${m.name} - Oldest Task')`
    );
  }
  params.append("from", "-1h");
  params.append("until", "now");
  params.append("format", "json");

  const json = await grafanaRender(params.toString());
  const out = {};

  for (const s of json) {
    if (!s || !Array.isArray(s.datapoints)) continue;
    const valid = s.datapoints.filter((dp) => dp[0] !== null);
    const last = valid.pop();
    if (!last) continue;

    const val = String(last[0]);
    const ts = new Date(last[1] * 1000).toISOString();
    const isOldest = s.target.includes("Oldest Task");
    const metric = s.target.replace(" - Total", "").replace(" - Oldest Task", "");

    if (!out[metric]) {
      out[metric] = {
        current: null,
        duration: null,
        durationRaw: null,
        lastUpdated: ts,
      };
    }

    if (isOldest) {
      out[metric].duration = formatDuration(val);
      out[metric].durationRaw = val;
    } else {
      out[metric].current = val;
    }
  }

  return out;
}

function mergeQueueProject(oldP, newData) {
  const old = oldP || {};
  const merged = {};
  let changed = false;

  for (const [m, nm] of Object.entries(newData)) {
    const om = old[m];
    let prev = om ? (om.previous ?? null) : null;
    const oldCur = om ? (om.current ?? null) : null;
    const newCur = nm.current ?? null;

    if (!om) changed = true;
    else if (oldCur !== newCur) {
      if (oldCur !== null) prev = oldCur;
      changed = true;
    }

    merged[m] = {
      current: newCur,
      duration: nm.duration,
      durationRaw: nm.durationRaw,
      previous: prev,
      lastUpdated: nm.lastUpdated,
    };
  }

  if (Object.keys(old).some((k) => !(k in newData))) changed = true;
  return { merged, changed };
}

async function runPool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

const queueState = {
  running: false,
  lastRunAt: null,
  lastDurationMs: null,
  lastProjectCount: 0,
  lastPushedCount: 0,
  lastErrorCount: 0,
  lastError: null,
};

async function runQueueCycle() {
  if (queueState.running) {
    return { skipped: true, reason: "previous cycle still running" };
  }

  queueState.running = true;
  const started = Date.now();

  try {
    const projects = await getQueueProjects();
    if (!projects.length) {
      console.log("  ⚠️ [QUEUE] No projects found");
      queueState.lastProjectCount = 0;
      queueState.lastPushedCount = 0;
      queueState.lastErrorCount = 0;
      queueState.lastError = null;
      queueState.lastRunAt = new Date().toISOString();
      queueState.lastDurationMs = Date.now() - started;
      return { projects: 0, pushed: 0, errors: 0 };
    }

    if (queueMirror === null) await loadQueueMirror();

    const updates = {};
    let errors = 0;
    let lastErr = null;

    await runPool(projects, QUEUE_CONCURRENCY, async (proj) => {
      try {
        const newData = await fetchQueueProject(proj);
        const oldP = queueMirror[proj];

        if (Object.keys(newData).length === 0) {
          if (oldP) updates[proj] = null;
          return;
        }

        const { merged, changed } = mergeQueueProject(oldP, newData);
        const heartbeat =
          QUEUE_HEARTBEAT_SEC > 0 &&
          Date.now() - (queueLastPush[proj] || 0) >= QUEUE_HEARTBEAT_SEC * 1000;

        if (changed || !oldP || heartbeat) updates[proj] = merged;
      } catch (e) {
        errors++;
        lastErr = e.message;
        console.error(`  ❌ [QUEUE] Error in ${proj}:`, e.message);
      }
    });

    const pset = new Set(projects);
    for (const k of Object.keys(queueMirror)) {
      if (!pset.has(k)) updates[k] = null;
    }

    const keys = Object.keys(updates);
    if (keys.length > 0) {
      await axios.patch(QUEUE_FIREBASE_URL, updates, { timeout: 30000 });

      const now = Date.now();
      let removed = 0;
      for (const k of keys) {
        if (updates[k] === null) {
          delete queueMirror[k];
          delete queueLastPush[k];
          removed++;
        } else {
          queueMirror[k] = updates[k];
          queueLastPush[k] = now;
        }
      }
      console.log(
        `🚀 [QUEUE] Firebase updated: ${keys.length - removed} pushed` +
          (removed ? `, ${removed} removed` : "") +
          (errors ? `, ${errors} error(s)` : "")
      );
    }

    queueState.lastProjectCount = projects.length;
    queueState.lastPushedCount = keys.length;
    queueState.lastErrorCount = errors;
    queueState.lastError = lastErr;
    queueState.lastRunAt = new Date().toISOString();
    queueState.lastDurationMs = Date.now() - started;

    return { projects: projects.length, pushed: keys.length, errors };
  } catch (e) {
    queueState.lastError = e.message;
    queueState.lastRunAt = new Date().toISOString();
    queueState.lastDurationMs = Date.now() - started;
    throw e;
  } finally {
    queueState.running = false;
  }
}

function startQueueAutoLoop() {
  if (!QUEUE_INTERVAL_SEC || QUEUE_INTERVAL_SEC <= 0) {
    console.log("  ⏸️ [QUEUE] Auto refresh disabled");
    return;
  }
  const loop = async () => {
    try {
      await runQueueCycle();
    } catch (e) {
      console.error("❌ [QUEUE] Cycle error:", e.message);
    }
    setTimeout(loop, QUEUE_INTERVAL_SEC * 1000);
  };
  loop();
}

/* ═══════════════════════════════════════════════════════════════
   LOOKUPS
   ═══════════════════════════════════════════════════════════════ */
async function fetchStaffLookup() {
  try {
    const r = await axios.get(STAFF_SHEET_URL, { responseType: "text" });
    return r.data;
  } catch (e) {
    console.error("Staff lookup error:", e.message);
    throw new Error("Failed to fetch staff sheet: " + e.message);
  }
}

async function fetchProjectTaskLookup() {
  try {
    const r = await axios.get(PROJECT_TASK_SHEET_URL(), {
      responseType: "text",
      timeout: 30000,
    });
    const lines = r.data.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return [];

    const splitLine = (l) =>
      l.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));

    const hdr = splitLine(lines[0]).map((h) => h.toLowerCase());
    const records = [];

    for (let i = 1; i < lines.length; i++) {
      const cells = splitLine(lines[i]);
      const rec = {};
      hdr.forEach((h, j) => {
        rec[h] = cells[j] || "";
      });
      records.push(rec);
    }
    return records;
  } catch (e) {
    throw new Error("Failed to fetch project/task sheet: " + e.message);
  }
}

/* ═══════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════ */
function parseIdsParam(q) {
  const raw = q.staff_ids || q.staff_id || q.tl_names || q.tl_name;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/* ═══════════════════════════════════════════════════════════════
   HTTP SERVER
   ═══════════════════════════════════════════════════════════════ */
const server = http.createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`);
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  const AUTH_EXEMPT = ["/fetch-filtered", "/planning-ui", "/cancellations-ui"];
  if (!AUTH_EXEMPT.includes(pathname) && !authenticate(req)) {
    console.log(`  ❌ Unauthorized: ${req.url}`);
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="QAT Server"',
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  try {
    /* ─── Health check ─── */
    if (pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "QAT Server - Unified",
          time: new Date().toISOString(),
          cors: "enabled",
          outflow_auto_interval_sec: OUTFLOW_AUTO_INTERVAL_SEC,
          queue_auto_interval_sec: QUEUE_INTERVAL_SEC,
          cancellation_auto_interval_sec: CANCELLATION_AUTO_INTERVAL_SEC,
          cancellation_firebase: CANCELLATION_FIREBASE_BASE,
          cancellation_table: CANCELLATION_TABLE,
          cancellation_columns: CANCELLATION_COL,
        })
      );
      return;
    }

    /* ─── ROSTER ─── */
    if (pathname === "/roster" && req.method === "GET") {
      const roster = await fetchStaffRoster(query.refresh === "1");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, count: roster.length, roster }));
      return;
    }

    if (pathname === "/roster/team" && req.method === "GET") {
      const tl = String(query.tl || query.tl_id || query.team_lead || "").trim();
      if (!tl) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "tl (Team Lead ID or name) required" }));
        return;
      }
      const roster = await fetchStaffRoster();
      const team = findTeamForTL(roster, tl);
      const teamLeads = [
        ...new Set(roster.map((r) => String(r.teamLead || "").trim()).filter(Boolean)),
      ].sort();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            success: true,
            tl_input: tl,
            tl_normalized: normalizeId(tl),
            team_size: team.length,
            team_members: team.map((r) => ({
              qatId: r.qatId,
              name: r.name,
              primary: r.primary,
              teamLead: r.teamLead,
            })),
            team_leads_in_roster: teamLeads,
          },
          null,
          2
        )
      );
      return;
    }

    /* ─── DEBUG: cancellations ─── */
    if (pathname === "/debug-cancellations" && req.method === "GET") {
      const dateStr = parseDateParam(query) || todayColombo();
      const tl = String(query.tl || query.tl_id || "").trim();

      let userIds = null;
      let teamInfo = null;

      if (tl) {
        const roster = await fetchStaffRoster();
        const team = findTeamForTL(roster, tl);
        userIds = team.map((r) => r.qatId);
        teamInfo = {
          tl_input: tl,
          tl_normalized: normalizeId(tl),
          team_size: team.length,
          team_ids: userIds,
        };
      }

      const q = buildQueryCancellations(dateStr, userIds);
      let err = null;
      let rowCount = null;
      let sample = [];

      try {
        const r = await grafanaRequest("POST", QUERY_URL, q);
        const { jobId, location } = r.data.jobReference;
        const url2 = `${QUERY_URL}/${jobId}?location=${location}`;
        const result = await getQueryResults(url2, 15);
        rowCount = (result.rows || []).length;
        sample = processCancellationResults(result).slice(0, 5);
      } catch (e) {
        err = {
          message: e.message,
          status: e.response && e.response.status,
          data: e.response && e.response.data,
        };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            success: !err,
            date: dateStr,
            team_info: teamInfo,
            sql: q.query,
            rowCount,
            sample,
            error: err,
          },
          null,
          2
        )
      );
      return;
    }

    /* ─── MODE 1: TEAM LEADER ─── */
    if (
      pathname === "/fetch-all" &&
      req.method === "GET" &&
      (!query.mode || query.mode === "tl")
    ) {
      const ids = parseIdsParam(query);
      const dateStr = parseDateParam(query);
      const all = await fetchAllTeamLeaders(ids, dateStr);
      await saveToFirebase(FIREBASE_PATH_TL, {
        updated_at: new Date().toISOString(),
        date: dateStr || "today",
        total_leaders: all.length,
        data: all,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          mode: "tl",
          date: dateStr || "today",
          data: all,
          total_leaders: all.length,
          updated_at: new Date().toISOString(),
        })
      );
      return;
    }

    /* ─── MODE 2: STAFF ID ─── */
    if (
      pathname === "/fetch-all" &&
      req.method === "GET" &&
      query.mode === "staff"
    ) {
      const ids = parseIdsParam(query);
      const dateStr = parseDateParam(query);
      const all = await fetchAllStaff(ids, dateStr);
      await saveToFirebase(FIREBASE_PATH_STAFF, {
        updated_at: new Date().toISOString(),
        date: dateStr || "today",
        total_leaders: all.length,
        data: all,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          mode: "staff",
          date: dateStr || "today",
          data: all,
          total_leaders: all.length,
          staff_ids: ids.length ? ids : TEAM_LEADERS,
          updated_at: new Date().toISOString(),
        })
      );
      return;
    }

    /* ─── SINGLE FETCH ─── */
    if (pathname === "/fetch" && req.method === "GET") {
      const dateStr = parseDateParam(query);

      if (query.staff_id) {
        const sid = String(query.staff_id).trim();
        const d = await fetchSingleStaff(sid, dateStr);
        await saveToFirebase(FIREBASE_PATH_STAFF, {
          updated_at: new Date().toISOString(),
          date: dateStr || "today",
          total_rows: d.total_rows,
          filter_config: { staff_id: sid, date: dateStr || "today" },
          data: d.rows,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            mode: "staff",
            date: dateStr || "today",
            rows: d.rows,
            total: d.total_rows,
            staff_id: sid,
            updated_at: new Date().toISOString(),
          })
        );
        return;
      }

      const tl = String(query.tl_name || TEAM_LEADERS[0]).trim();
      const d = await fetchSingleTL(tl, dateStr);
      await saveToFirebase(FIREBASE_PATH_TL, {
        updated_at: new Date().toISOString(),
        date: dateStr || "today",
        total_rows: d.total_rows,
        filter_config: { tl_name: tl, date: dateStr || "today" },
        data: d.rows,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          mode: "tl",
          date: dateStr || "today",
          rows: d.rows,
          total: d.total_rows,
          tl_name: tl,
          updated_at: new Date().toISOString(),
        })
      );
      return;
    }

    /* ─── MODE 3: FILTERED ─── */
    if (pathname === "/fetch-filtered" && req.method === "GET") {
      const p = (query.project || "").trim();
      const t = (query.task || "").trim();
      const dateStr = parseDateParam(query);

      if (!p || !t) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "project සහ task දෙකම required" }));
        return;
      }

      const rows = await fetchFilteredByProjectTask(p, t, dateStr);
      await saveToFirebase(FIREBASE_PATH_FILTERED, {
        updated_at: new Date().toISOString(),
        date: dateStr || "today",
        total_rows: rows.length,
        filter_config: { project: p, task: t, date: dateStr || "today" },
        data: rows,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          mode: "filtered",
          date: dateStr || "today",
          rows,
          total: rows.length,
          project: p,
          task: t,
          updated_at: new Date().toISOString(),
        })
      );
      return;
    }

    /* ─── MODE 5: OUTFLOW ─── */
    if (pathname === "/fetch-outflow" && req.method === "GET") {
      const r = resolveOutflowRange(query);
      if (r.error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: r.error }));
        return;
      }

      let rows;
      let updatedAt;
      if (r.isToday) {
        const p = await refreshOutflow();
        rows = p.data;
        updatedAt = p.lastUpdated;
      } else {
        rows = await fetchOutflow(r.from, r.to);
        updatedAt = new Date().toISOString();
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          mode: "outflow",
          range: r.key,
          date: r.isToday
            ? "today"
            : r.from === r.to
            ? r.from
            : `${r.from}..${r.to}`,
          from: r.from,
          to: r.to,
          rows,
          total: rows.length,
          updated_at: updatedAt,
          saved_to_firebase: r.isToday,
        })
      );
      return;
    }

    /* ─── MODE 7: CANCELLATIONS ─── */
    if (pathname === "/fetch-cancellations" && req.method === "GET") {
      const requested = parseDateParam(query);
      const targetDate = requested || todayColombo();
      const tl = String(
        query.tl || query.tl_id || query.team_lead || query.team_leader || ""
      ).trim();

      if (targetDate > todayColombo()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ success: false, error: "Cannot fetch future dates" })
        );
        return;
      }

      /* ─── TL-scoped branch ─── */
      if (tl) {
        const roster = await fetchStaffRoster();
        const team = findTeamForTL(roster, tl);
        const userIds = team.map((r) => r.qatId);
        const teamNames = team.map((r) => ({ qatId: r.qatId, name: r.name }));

        const tlNorm = normalizeId(tl);
        if (tlNorm && !userIds.some((x) => normalizeId(x) === tlNorm)) {
          userIds.push(tl);
        }

        const teamInfo = {
          tl_input: tl,
          tl_normalized: tlNorm,
          team_size: team.length,
          team_ids: userIds,
          team_names: teamNames,
        };

        const rows = await fetchCancellations(targetDate, userIds);
        const payload = {
          lastUpdated: new Date().toISOString(),
          date: targetDate,
          timezone: "Asia/Colombo",
          tl,
          team_size: team.length,
          total_rows: rows.length,
          data: rows,
        };

        await saveCancellationsTeamToFirebase(tlNorm, targetDate, payload);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            mode: "cancellations",
            filter: "team",
            date: targetDate,
            timezone: "Asia/Colombo",
            team_info: teamInfo,
            rows,
            total: rows.length,
            updated_at: payload.lastUpdated,
            saved_to_firebase: true,
          })
        );
        return;
      }

      /* ─── Global branch ─── */
      const payload =
        targetDate === todayColombo()
          ? await refreshCancellations()
          : await (async () => {
              const rows = await fetchCancellations(targetDate, null);
              const p = {
                lastUpdated: new Date().toISOString(),
                date: targetDate,
                timezone: "Asia/Colombo",
                total_rows: rows.length,
                data: rows,
              };
              await saveCancellationsDateToFirebase(targetDate, p);
              return p;
            })();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          mode: "cancellations",
          filter: "all",
          date: payload.date,
          timezone: payload.timezone,
          rows: payload.data,
          total: payload.total_rows,
          updated_at: payload.lastUpdated,
          saved_to_firebase: true,
          is_today: targetDate === todayColombo(),
        })
      );
      return;
    }

    /* ─── READ CANCELLATIONS (Firebase) ─── */
    if (pathname === "/cancellations" && req.method === "GET") {
      const requested = parseDateParam(query);
      const targetDate = requested || todayColombo();
      const tl = String(query.tl || "").trim();

      const readUrl = tl
        ? CANCELLATION_TEAM_URL(normalizeId(tl), targetDate)
        : targetDate === todayColombo()
        ? CANCELLATION_TODAY_URL
        : CANCELLATION_ARCHIVE_URL(targetDate);

      try {
        const r = await axios.get(readUrl, { timeout: 30000 });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            mode: "cancellations-read",
            date: targetDate,
            tl: tl || null,
            source: readUrl,
            payload: r.data || null,
          })
        );
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            mode: "cancellations-read",
            date: targetDate,
            tl: tl || null,
            source: readUrl,
            payload: null,
            note: "No data at that node yet",
          })
        );
      }
      return;
    }

    /* ─── MODE 6: QUEUE MONITOR ─── */
    if (pathname === "/queue-monitor/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          mode: "queue-monitor",
          ...queueState,
          config: {
            interval_sec: QUEUE_INTERVAL_SEC,
            concurrency: QUEUE_CONCURRENCY,
            heartbeat_sec: QUEUE_HEARTBEAT_SEC,
            projects_cache_sec: QUEUE_PROJECTS_CACHE_SEC,
            projects_source: SERVER_PROJECTS_URL,
            destination: QUEUE_FIREBASE_URL,
          },
          projects: queueProjectsCache.list,
          project_count: queueProjectsCache.list.length,
        })
      );
      return;
    }

    if (pathname === "/queue-monitor/refresh" && req.method === "GET") {
      if (queueState.running) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            error: "A queue monitor cycle is already running",
          })
        );
        return;
      }
      await getQueueProjects(true);
      const s = await runQueueCycle();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          mode: "queue-monitor",
          ...s,
          updated_at: new Date().toISOString(),
        })
      );
      return;
    }

    /* ─── UIs ─── */
    if (pathname === "/planning-ui" && req.method === "GET") {
      fs.readFile(PLANNING_HTML_PATH, "utf8", (e, h) => {
        if (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "planning.html not found: " + e.message }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(h);
      });
      return;
    }

    if (pathname === "/cancellations-ui" && req.method === "GET") {
      fs.readFile(CANCELLATIONS_HTML_PATH, "utf8", (e, h) => {
        if (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "cancellations.html not found: " + e.message }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(h);
      });
      return;
    }

    /* ─── MODE 4: PLANNING ─── */
    if (pathname === "/planning" && req.method === "GET") {
      const m = (await getFromFirebase(FIREBASE_PATH_PLANNING)) || {};
      const list = Object.entries(m).map(([id, e]) => ({ id, ...e }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: list, count: list.length }));
      return;
    }

    if (pathname === "/planning" && req.method === "POST") {
      let b;
      try {
        b = await readJsonBody(req);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
        return;
      }

      const p = String(b.project_name || "").trim();
      const t = String(b.task_name || "").trim();
      const tg = Number(b.target);

      if (!p || !t || !Number.isFinite(tg) || tg < 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "project_name, task_name, target (>= 0) required",
          })
        );
        return;
      }

      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const entry = {
        project_name: p,
        task_name: t,
        target: tg,
        actual: 0,
        percentage: 0,
        created_at: new Date().toISOString(),
      };
      await axios.put(`${FIREBASE_URL}/planning/${id}.json`, entry);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, id, data: entry }));
      return;
    }

    if (pathname === "/planning" && req.method === "DELETE") {
      const id = String(query.id || "").trim();
      if (!id) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "id required" }));
        return;
      }
      await axios.delete(`${FIREBASE_URL}/planning/${id}.json`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, id }));
      return;
    }

    if (pathname === "/planning-fetch" && req.method === "GET") {
      const dateStr = parseDateParam(query);
      const u = await refreshAllPlanning(dateStr);
      const list = Object.entries(u).map(([id, e]) => ({ id, ...e }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          date: dateStr || "today",
          data: list,
          count: list.length,
          updated_at: new Date().toISOString(),
        })
      );
      return;
    }

    /* ─── Lookups ─── */
    if (pathname === "/staff-lookup" && req.method === "GET") {
      const csv = await fetchStaffLookup();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ csv }));
      return;
    }

    if (pathname === "/project-task-lookup" && req.method === "GET") {
      try {
        const d = await fetchProjectTaskLookup();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, data: d, count: d.length }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === "/denominator-lookup" && req.method === "GET") {
      try {
        const d = await getDenominatorData(true);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            data: d,
            count: {
              byProjectTask: Object.keys(d.byProjectTask).length,
              byGID: Object.keys(d.byGID).length,
              uf: Object.keys(d.uf || {}).length,
            },
          })
        );
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (
      (pathname === "/team-leaders" || pathname === "/staff-ids") &&
      req.method === "GET"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          staff_ids: TEAM_LEADERS,
          team_leaders: TEAM_LEADERS,
          count: TEAM_LEADERS.length,
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (e) {
    console.error("❌ Server Error:", e.message);
    console.error("  Stack:", e.stack);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message, details: e.stack }));
  }
});

/* ═══════════════════════════════════════════════════════════════
   START
   ═══════════════════════════════════════════════════════════════ */
server.listen(PORT, HOST, () => {
  console.log("================================");
  console.log(`  🚀 QAT Server (Unified) on http://${HOST}:${PORT}`);
  console.log(`  🔐 Basic Auth user: ${AUTH_USER}`);
  console.log(`  🌐 CORS: enabled for all origins`);
  console.log(`  🔥 Firebase paths:`);
  console.log(`     TL mode         -> ${FIREBASE_PATH_TL}`);
  console.log(`     Staff mode      -> ${FIREBASE_PATH_STAFF}`);
  console.log(`     Filtered        -> ${FIREBASE_PATH_FILTERED}`);
  console.log(`     Planning        -> ${FIREBASE_PATH_PLANNING}`);
  console.log(`     Outflow         -> ${FIREBASE_OUTFLOW_URL}`);
  console.log(`     Queue           -> ${QUEUE_FIREBASE_URL}`);
  console.log(`     Queue source    -> ${SERVER_PROJECTS_URL}`);
  console.log(`     Cancellations   -> ${CANCELLATION_TODAY_URL}`);
  console.log(`     Cancel archive  -> ${CANCELLATION_FIREBASE_BASE}/cancellations-by-date/<date>.json`);
  console.log(`     Cancel by TL    -> ${CANCELLATION_FIREBASE_BASE}/cancellations-by-tl/<tl>/<date>.json`);
  console.log(`  📊 Cancel table: ${CANCELLATION_TABLE}`);
  console.log(`  📊 Cancel cols:`);
  Object.entries(CANCELLATION_COL).forEach(([k, v]) =>
    console.log(`       ${k.padEnd(10)} -> ${v}`)
  );
  console.log(`  📋 Roster:`);
  console.log(`     source          -> ${ROSTER_CSV_URLS[0]}`);
  console.log(`  📡 Endpoints:`);
  console.log(`    GET  /                                Health check`);
  console.log(`    GET  /fetch-all?mode=tl               All Team Leaders`);
  console.log(`    GET  /fetch-all?mode=staff            Given staff ids`);
  console.log(`    GET  /fetch?tl_name=                  Single TL`);
  console.log(`    GET  /fetch?staff_id=                 Single staff`);
  console.log(`    GET  /fetch-filtered?project=&task=   Project+Task`);
  console.log(`    GET  /fetch-outflow                   Today outflow`);
  console.log(`    GET  /fetch-outflow?range=...         Past preset`);
  console.log(`    GET  /fetch-outflow?from=&to=         Range`);
  console.log(`    GET  /fetch-cancellations                    All cancellations (today)`);
  console.log(`    GET  /fetch-cancellations?date=YYYY-MM-DD    All for a date`);
  console.log(`    GET  /fetch-cancellations?tl=G22371-OTL      TL-scoped`);
  console.log(`    GET  /fetch-cancellations?date=&tl=          TL-scoped for date`);
  console.log(`    GET  /cancellations?date=&tl=         Read Firebase`);
  console.log(`    GET  /roster                          Full staff roster`);
  console.log(`    GET  /roster/team?tl=G22371-OTL       Team members for a TL`);
  console.log(`    GET  /debug-cancellations?date=&tl=   Debug SQL + sample`);
  console.log(`    GET  /queue-monitor/status            Queue status`);
  console.log(`    GET  /queue-monitor/refresh           Run queue cycle`);
  console.log(`    GET  /planning-ui                     Planning page`);
  console.log(`    GET  /cancellations-ui                Cancellations page`);
  console.log(`    GET  /planning                        List planning`);
  console.log(`    POST /planning                        Add planning`);
  console.log(`    DEL  /planning?id=                    Remove planning`);
  console.log(`    GET  /planning-fetch                  Refresh planning`);
  console.log(`    GET  /staff-lookup                    Staff lookup`);
  console.log(`    GET  /project-task-lookup             Project/task lookup`);
  console.log(`    GET  /denominator-lookup              Denominator lookup`);
  console.log(`    GET  /team-leaders | /staff-ids       Default id list`);
  console.log("================================");

  startOutflowAutoLoop();
  startQueueAutoLoop();
  startCancellationsAutoLoop();
});

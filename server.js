// Local development: load .env if present (Node 20.12+ / 21.7+). On Render use dashboard env vars.
const fs = require("fs");
try {
  if (typeof process.loadEnvFile === "function" && fs.existsSync(".env")) process.loadEnvFile(".env");
} catch (e) {
  console.warn("⚠️ Could not load .env:", e.message);
}

const axios = require("axios");
const http = require("http");
const url = require("url");
const path = require("path");
const crypto = require("crypto");

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
| Meka thani server ekakin thanku data 8ma type eka handle karanawa:
|   1. Team Leader (TL Hourly)   -> /TL Hourly.json
|        *** team_leader_staff_id eken nemei, staff sheet (roster) eken
|        select karapu Shift Sup / Team Leader ta adala STAFF IDs walata data
|        aran, Team Leader ID eka yatathe table ekak widihata Firebase ekata
|        save karanawa. ***
|   2. Staff ID (staff_id) fetch                 -> /QAT2 Output.json
|   3. Project + Task filtered fetch             -> /qat_filtered.json
|   4. Planning (project + task + target, multi) -> /planning.json
|   5. Project Outflow (project | task | center) -> projectgap Firebase
|   6. QUEUE MONITOR (Grafana queue total + oldest task, per project)
|   7. CANCELLATION (qat_cancelation_data table)
|   8. TRAX TEAM MONITOR (smart-prod.trax-cloud.com locked tasks, per project)
|        -> GET /monitor , GET /monitor/project/<name>
|
| TL HOURLY (MODE 1):
|   GET /fetch-all                                   -> default TEAM_LEADERS (roster eken staff resolve)
|   GET /fetch-all?shift_sup=Thevidu                 -> Shift Sup ge okkoma staff
|   GET /fetch-all?shift_sup=All                     -> roster eke okkoma staff
|   GET /fetch-all?shift_sup=Thevidu&team_leader=G123-OTL -> eka TL ge staff
|   GET /fetch-all?team_leader=G123-OTL              -> eka TL ge staff
|   (okkotama optional &date=YYYY-MM-DD)
|
| Firebase shape (/TL Hourly.json):
|   {
|     updated_at, date, filter_config, total_leaders,
|     team_leaders: { "<TL_ID>": { tl_name, staff_ids[], total_rows, rows[] } },
|     data: [ { tl_name, rows, total_rows, fetched_at } ]   // backward compat
|   }
|--------------------------------------------------------------------------
*/
const QUERY_URL =
  "https://monitor-public.trax-cloud.com/api/datasources/proxy/133/bigquery/v2/projects/trax-ortal-prod/queries";

const FIREBASE_URL = "https://qat-output-default-rtdb.firebaseio.com";

const FIREBASE_PATH_TL       = "/TL Hourly.json";
const FIREBASE_PATH_STAFF    = "/QAT2 Output.json";
const FIREBASE_PATH_FILTERED = "/qat_filtered.json";
const FIREBASE_PATH_PLANNING = "/planning.json";

const FIREBASE_OUTFLOW_URL =
  "https://projectgap-4b7d9-default-rtdb.firebaseio.com/project-gaps.json";

const OUTFLOW_AUTO_INTERVAL_SEC = Number(process.env.OUTFLOW_INTERVAL_SEC ?? 10);
const OUTFLOW_MAX_RANGE_DAYS = Number(process.env.OUTFLOW_MAX_RANGE_DAYS ?? 92);
const PREVIOUS_WEEK_MODE = (process.env.PREVIOUS_WEEK_MODE || "calendar").toLowerCase();

/*
|--------------------------------------------------------------------------
| MODE 6 CONFIG - QUEUE MONITOR
|--------------------------------------------------------------------------
*/
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

/*
|--------------------------------------------------------------------------
| MODE 7 CONFIG - CANCELLATION
|--------------------------------------------------------------------------
*/
const CANCELLATION_FIREBASE_URL =
  process.env.CANCELLATION_FIREBASE_URL ||
  "https://cancellation-7294a-default-rtdb.firebaseio.com/qat_cancelation_data.json";

const CANCEL_TABLE = "trax-retail.backoffice.qat_cancelation_data";
const CANCEL_STAFF_COLUMN = process.env.CANCEL_STAFF_COLUMN || "user";
const CANCEL_DATE_COLUMN = process.env.CANCEL_DATE_COLUMN || "timestamp";
const COLUMN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PLANNING_HTML_PATH = path.join(__dirname, "planning.html");
const TRAX_DASHBOARD_PATH = path.join(__dirname, "dashboard.html");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// Default Team Leader / Staff IDs list
const TEAM_LEADERS = [
  "G26658-OTL",
  "G25883-OTL",
  "G22371-OTL",
  "G23179-OTL"
];

// Staff lookup sheet (roster)
const STAFF_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=1860286382&output=csv";

// Project/Task lookup sheet (denominator matrix source)
const PROJECT_TASK_SHEET_URL = () =>
  `https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=822634964&output=csv&_=${Date.now()}`;

// Roster eken staff IDs godak unoth BigQuery query ekata chunk walata kadanawa
const STAFF_QUERY_CHUNK = Number(process.env.STAFF_QUERY_CHUNK ?? 400);
const ROSTER_CACHE_MS = Number(process.env.ROSTER_CACHE_SEC ?? 300) * 1000;

/*
|--------------------------------------------------------------------------
| CREDENTIALS  (stored in this file - no .env needed)
|--------------------------------------------------------------------------
| Edit the values in CREDENTIALS below. If an environment variable with the
| same name is set (e.g. in Render), it overrides the value here.
| Keep this file in a PRIVATE repo - anyone who can read it can read these.
|--------------------------------------------------------------------------
*/
const CREDENTIALS = {
  // Basic-Auth login for this server (dashboard / React apps use this)
  AUTH_USER: "admin",
  AUTH_PASS: "password123",

  // Grafana (BigQuery proxy + queue monitor)
  GRAFANA_USER: "gss.kurunegala@gssintl.biz",
  GRAFANA_PASS: "Gssk@2021",

  // Trax (https://smart-prod.trax-cloud.com/home) login - MODE 8 (Team Monitor)
  TRAX_USER: "thevidu@gssintl.biz",
  TRAX_PASS: "202561208202690Ts@@@@",
};
const cred = (k) => process.env[k] || CREDENTIALS[k];

const AUTH_USER = cred("AUTH_USER");
const AUTH_PASS = cred("AUTH_PASS");
const GRAFANA_USER = cred("GRAFANA_USER");
const GRAFANA_PASS = cred("GRAFANA_PASS");
const TRAX_USER = cred("TRAX_USER");
const TRAX_PASS = cred("TRAX_PASS");

// Paths that can be opened without Basic Auth (comma separated). Default: only the static planning page.
const AUTH_EXEMPT_PATHS = (process.env.AUTH_EXEMPT_PATHS ?? "/planning-ui")
  .split(",").map((s) => s.trim()).filter(Boolean);

/*
|--------------------------------------------------------------------------
| CORS HEADERS
|--------------------------------------------------------------------------
| CORS_ORIGIN defaults to "*". Auth uses the Authorization header (not cookies),
| so "*" works. Set CORS_ORIGIN=https://your-site.com to lock it down.
|--------------------------------------------------------------------------
*/
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Accept",
  "Access-Control-Max-Age": "86400"
};

function setCorsHeaders(res) {
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
}

// constant-time compare (hash first so lengths always match)
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function authenticate(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !/^Basic\s+/i.test(authHeader)) return false;
  try {
    const base64 = authHeader.replace(/^Basic\s+/i, "").trim();
    const credentials = Buffer.from(base64, "base64").toString("utf8");
    const idx = credentials.indexOf(":");           // password may itself contain ":"
    if (idx < 0) return false;
    const user = credentials.slice(0, idx);
    const pass = credentials.slice(idx + 1);
    const userOk = safeEqual(user, AUTH_USER);
    const passOk = safeEqual(pass, AUTH_PASS);
    return userOk && passOk;
  } catch {
    return false;
  }
}

/*
|--------------------------------------------------------------------------
| DATE PARAM HELPERS
|--------------------------------------------------------------------------
*/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseYMD(raw) {
  const s = raw ? String(raw).trim() : "";
  if (!s || !DATE_RE.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return s;
}

function parseDateParam(query) {
  return parseYMD(query && query.date);
}

function buildDateRangeClause(dateStr) {
  if (dateStr) {
    return `event_timestamp BETWEEN TIMESTAMP('${dateStr} 00:00:00') AND TIMESTAMP('${dateStr} 23:59:59.999999')`;
  }
  return `event_timestamp BETWEEN TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY) AND CURRENT_TIMESTAMP()`;
}

/*
|--------------------------------------------------------------------------
| SQL STRING HELPERS
|--------------------------------------------------------------------------
*/
function sqlEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function normalizeIdSql(value) {
  return sqlEscape(String(value).trim().toUpperCase());
}

function buildIdMatchSql(column, value) {
  const id = normalizeIdSql(value);
  const col = `UPPER(TRIM(${column}))`;
  return `(${col} = '${id}' OR STARTS_WITH(${col}, '${id}-'))`;
}

// NEW: staff IDs list ekak exact (case-insensitive) match karanawa
function buildIdListMatchSql(column, ids) {
  const list = ids.map(id => `'${normalizeIdSql(id)}'`).join(", ");
  return `UPPER(TRIM(${column})) IN UNNEST([${list}])`;
}

/*
|--------------------------------------------------------------------------
| OUTFLOW DATE RANGE RESOLVER
|--------------------------------------------------------------------------
*/
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

function daysBetweenInclusive(fromStr, toStr) {
  const a = Date.parse(`${fromStr}T00:00:00Z`);
  const b = Date.parse(`${toStr}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

function resolveOutflowRange(query) {
  const today = todayUTC();
  const todayStr = ymdUTC(today);
  const range = query.range ? String(query.range).trim().toLowerCase() : "";
  const fromRaw = query.from ? String(query.from).trim() : "";
  const toRaw = query.to ? String(query.to).trim() : "";

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
  } else if (query.date) {
    const d = parseDateParam(query);
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

/*
|--------------------------------------------------------------------------
| GRAFANA SESSION MANAGER (auto login + auto refresh on 401/403)
|--------------------------------------------------------------------------
*/
let grafanaSession = null;
let loginPromise = null;

async function loginToGrafana() {
  console.log("🔐 Logging into Grafana to get fresh session...");

  try {
    const response = await axios.post(
      "https://monitor-public.trax-cloud.com/login",
      { user: GRAFANA_USER, password: GRAFANA_PASS },
      {
        headers: { "Content-Type": "application/json" },
        maxRedirects: 0,
        validateStatus: (status) => status < 400 || status === 401 || status === 403,
        timeout: 30000
      }
    );

    console.log(`  Login response status: ${response.status}`);

    const setCookieHeader = response.headers['set-cookie'];
    if (setCookieHeader) {
      const cookieArray = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      for (const cookie of cookieArray) {
        const match = cookie.match(/grafana_session=([^;]+)/);
        if (match) {
          grafanaSession = match[1];
          console.log("✅ New Grafana session obtained successfully!");
          return grafanaSession;
        }
      }
    }

    throw new Error("Login successful but grafana_session cookie not found in response.");
  } catch (error) {
    console.error("❌ Grafana login failed:", error.message);
    if (error.response) {
      console.error("  Response status:", error.response.status);
      console.error("  Response data:", error.response.data);
    }
    throw new Error(`Grafana login failed: ${error.message}`);
  }
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
    "Cookie": `grafana_session=${grafanaSession}`
  };
}

async function grafanaRequest(method, reqUrl, data = null, retryCount = 0) {
  try {
    const headers = await getGrafanaHeaders();
    const config = { headers, timeout: 30000 };
    let response;
    if (method === 'GET') {
      response = await axios.get(reqUrl, config);
    } else if (method === 'POST') {
      response = await axios.post(reqUrl, data, config);
    }
    return response;
  } catch (error) {
    if (error.response && (error.response.status === 401 || error.response.status === 403) && retryCount < 2) {
      console.warn("⚠️ Session expired or invalid. Refreshing Grafana session...");
      grafanaSession = null;
      loginPromise = null;
      return grafanaRequest(method, reqUrl, data, retryCount + 1);
    }
    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| BIGQUERY — poll until job complete
|--------------------------------------------------------------------------
*/
async function getQueryResults(resultUrl, maxTries = 10) {
  for (let i = 0; i < maxTries; i++) {
    const res = await grafanaRequest('GET', resultUrl);
    if (res.data.jobComplete) return res.data;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("BigQuery job timeout");
}

/*
|--------------------------------------------------------------------------
| BUILD SQL — variants
|--------------------------------------------------------------------------
*/

// LEGACY: team_leader_staff_id column eken (roster ekata TL nathnam fallback widihata witharak)
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
        SUM(
          CASE
            WHEN LOWER(TRIM(task_name)) = 'stitching' THEN number_of_probes
            ELSE count
          END
        ) AS value
      FROM \`trax-retail.backoffice.tl_hourly_report\`
      WHERE
        ${dateClause}
        AND task_name    IS NOT NULL
        AND project_name IS NOT NULL
        AND ${idMatch}
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY timestamp
    `,
    useLegacySql: false,
  };
}

// NEW: staff IDs list ekakata adala data (TL Hourly eka dan meken)
function buildQueryByStaffIdList(staffIds, dateStr) {
  const idMatch = buildIdListMatchSql("staff_id", staffIds);
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
        SUM(
          CASE
            WHEN LOWER(TRIM(task_name)) = 'stitching' THEN number_of_probes
            ELSE count
          END
        ) AS value
      FROM \`trax-retail.backoffice.tl_hourly_report\`
      WHERE
        ${dateClause}
        AND task_name    IS NOT NULL
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
        SUM(
          CASE
            WHEN LOWER(TRIM(task_name)) = 'stitching' THEN number_of_probes
            ELSE count
          END
        ) AS value
      FROM \`trax-retail.backoffice.tl_hourly_report\`
      WHERE
        ${dateClause}
        AND task_name    IS NOT NULL
        AND project_name IS NOT NULL
        AND ${idMatch}
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY timestamp
    `,
    useLegacySql: false,
  };
}

function buildQueryByProjectTask(project, task, dateStr) {
  const safeProject = sqlEscape(project);
  const safeTask = sqlEscape(task);
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
      WHERE
        ${dateClause}
        AND task_name IS NOT NULL
        AND project_name = '${safeProject}'
        AND task_name    = '${safeTask}'
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY timestamp
    `,
    useLegacySql: false,
  };
}

function buildQueryOutflow(fromStr, toStr) {
  let dateClause;
  if (fromStr && toStr) {
    dateClause = fromStr === toStr
      ? `DATE(event_timestamp) = DATE('${fromStr}')`
      : `DATE(event_timestamp) BETWEEN DATE('${fromStr}') AND DATE('${toStr}')`;
  } else {
    dateClause = `DATE(event_timestamp) = CURRENT_DATE()`;
  }
  return {
    query: `
      #standardSQL
      SELECT
        project_name,
        task_name,
        center,
        SUM(count) AS value
      FROM \`trax-retail.backoffice.560_project_outflow\`
      WHERE ${dateClause}
      GROUP BY 1, 2, 3
      ORDER BY value DESC
    `,
    useLegacySql: false,
  };
}

function buildQueryCancellation(staffIds, dateStr) {
  if (!COLUMN_NAME_RE.test(CANCEL_STAFF_COLUMN) || !COLUMN_NAME_RE.test(CANCEL_DATE_COLUMN)) {
    throw new Error("Invalid CANCEL_STAFF_COLUMN / CANCEL_DATE_COLUMN");
  }
  const conditions = [];

  if (staffIds && staffIds.length) {
    const idClauses = staffIds.map(id => buildIdMatchSql("`" + CANCEL_STAFF_COLUMN + "`", id));
    conditions.push(`(${idClauses.join(" OR ")})`);
  }
  if (dateStr) {
    conditions.push(`DATE(\`${CANCEL_DATE_COLUMN}\`) = DATE('${dateStr}')`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return {
    query: `#standardSQL\nSELECT * FROM \`${CANCEL_TABLE}\` ${where} ORDER BY \`${CANCEL_DATE_COLUMN}\``,
    useLegacySql: false,
  };
}

/*
|--------------------------------------------------------------------------
| TEMPLATE NAME LOOKUP
|--------------------------------------------------------------------------
*/
const normKeySimple = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');

const TEMPLATE_NAME_TASKS = new Set([
  'voting_engine',
  'offline_validation',
  'voting',
  'validation',
  'offline_voting'
]);

function isTemplateNameTask(taskName) {
  return TEMPLATE_NAME_TASKS.has(normKeySimple(taskName));
}

/*
|--------------------------------------------------------------------------
| PROCESS ROWS
|--------------------------------------------------------------------------
*/
function processResults(result) {
  if (!result.rows) return [];
  const fields = result.schema.fields.map(f => f.name);
  return result.rows
    .map(row => {
      const obj = {};
      row.f.forEach((cell, i) => { obj[fields[i]] = cell.v; });
      return obj;
    })
    .filter(obj => {
      const staff = String(obj.staff_id || "").trim().toLowerCase();
      return staff !== "" && staff !== "auto_stitch";
    })
    .map(obj => {
      const row = {
        timestamp: obj.timestamp || "",
        project_name: obj.project_name || "",
        task_name: obj.task_name || "",
        staff_id: obj.staff_id || "",
        value: Number(obj.value || 0),
      };
      const isPges = normKeySimple(obj.project_name) === 'pges';
      const isUFPriority = UF_PRIORITY_PROJECTS.has(normKeySimple(obj.project_name));
      if ((isTemplateNameTask(obj.task_name) || isPges || isUFPriority) && obj.template_name) {
        row.template_name = obj.template_name;
      }
      return row;
    });
}

function processOutflowResults(result) {
  if (!result.rows) return [];
  const fields = result.schema.fields.map(f => f.name);
  return result.rows.map(row => {
    const obj = {};
    row.f.forEach((cell, i) => { obj[fields[i]] = cell.v; });
    return {
      project: obj.project_name || "N/A",
      task: obj.task_name || "N/A",
      center: obj.center || "N/A",
      value: Number(obj.value || 0),
    };
  });
}

function processGenericResults(result) {
  if (!result.rows) return [];
  const fields = result.schema.fields.map(f => f.name);
  return result.rows.map(row => {
    const obj = {};
    row.f.forEach((cell, i) => { obj[fields[i]] = cell.v; });
    return obj;
  });
}

/*
|--------------------------------------------------------------------------
| FIREBASE SAVE / READ
|--------------------------------------------------------------------------
*/
async function saveToFirebase(firebasePath, payload) {
  await axios.put(`${FIREBASE_URL}${firebasePath}`, payload);
  console.log(`  🔥 Firebase updated at "${firebasePath}"`);
}

async function getFromFirebase(firebasePath) {
  try {
    const res = await axios.get(`${FIREBASE_URL}${firebasePath}`);
    return res.data || null;
  } catch (err) {
    console.error(`  🔥 Firebase read error (${firebasePath}):`, err.message);
    return null;
  }
}

async function saveOutflowToFirebase(payload) {
  await axios.put(FIREBASE_OUTFLOW_URL, payload, { timeout: 30000 });
  console.log("  🔥 Outflow Firebase updated (project-gap.json)");
}

async function saveCancellationToFirebase(payload) {
  await axios.put(CANCELLATION_FIREBASE_URL, payload, { timeout: 60000 });
  console.log("  🔥 Cancellation Firebase updated (qat_cancelation_data.json)");
}

/*
|--------------------------------------------------------------------------
| DENOMINATOR LOOKUP (normalized keys - lowercase + trimmed)
|--------------------------------------------------------------------------
*/
const normKey = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');

const UF_PRIORITY_PROJECTS = new Set([
  'batru',
  'diageopl', 'diageoes', 'diageopebac', 'diageoromania', 'aneuae',
  'rjreynoldsus', 'diageomx', 'diageobenelux', 'diageoga', 'diageoza',
  'diageoug', 'diageoca', 'diageouk', 'diageoit', 'diageoco', 'diageotz',
  'frucorau', 'diageogr', 'diageoin', 'diageoie', 'diageoar', 'diageoke',
  'diageostr', 'diageogtr'
].map(normKey));

const TASK_EQUIV_GROUPS = {
  voting: ['voting', 'offline_voting'],
  offline_voting: ['voting', 'offline_voting'],
  validation: ['validation', 'offline_validation'],
  offline_validation: ['validation', 'offline_validation'],
};

function taskEquivalents(task) {
  const t = normKey(task);
  return TASK_EQUIV_GROUPS[t] || [t];
}

function ufKey(project, task, subtask) {
  return `${normKey(project)}||${normKey(task)}||${normKey(subtask)}`;
}

const NON_TASK_HEADERS = new Set(['vlookup', 'region']);

const UF_COL_PROJECT = 26;
const UF_COL_TASK = 27;
const UF_COL_SUBTASK = 28;
const UF_COL_DENOMINATOR = 29;

let denominatorCache = {
  data: null,
  timestamp: null,
  cacheDuration: 5 * 60 * 1000
};

async function fetchDenominatorSheet() {
  try {
    console.log("📊 Fetching project/task denominator matrix...");
    const response = await axios.get(PROJECT_TASK_SHEET_URL(), {
      responseType: 'text',
      timeout: 30000
    });

    const lines = response.data.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 3) return { byProjectTask: {}, byGID: {}, rows: [], uf: {}, ufRowsByProject: {} };

    const splitLine = (line) =>
      line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));

    const headerCells = splitLine(lines[1]);

    let mainTableEnd = headerCells.length;
    for (let c = 1; c < headerCells.length; c++) {
      const h = normKey(headerCells[c]);
      if (!h || NON_TASK_HEADERS.has(h)) { mainTableEnd = c; break; }
    }
    const taskNames = headerCells.slice(1, mainTableEnd).map(h => normKey(h));

    const denominatorMap = { byProjectTask: {}, byGID: {}, rows: [], uf: {}, ufRowsByProject: {} };

    for (let i = 2; i < lines.length; i++) {
      const cells = splitLine(lines[i]);

      const project = normKey(cells[0] || '');
      if (project) {
        for (let j = 1; j <= taskNames.length; j++) {
          const taskName = taskNames[j - 1];
          if (!taskName) continue;
          const raw = (cells[j] || '').trim();
          if (!raw || raw === '-') continue;
          const denominator = parseFloat(raw);
          if (isNaN(denominator)) continue;
          const key = `${project}||${taskName}`;
          denominatorMap.byProjectTask[key] = denominator;
          denominatorMap.rows.push({ project, task: taskName, denominator });
        }
      }

      const ufProject = (cells[UF_COL_PROJECT] || '').trim();
      const ufTask = (cells[UF_COL_TASK] || '').trim();
      const ufSubtask = (cells[UF_COL_SUBTASK] || '').trim();
      const ufDenomRaw = (cells[UF_COL_DENOMINATOR] || '').trim();
      if (ufProject && ufTask && ufSubtask && ufDenomRaw && ufDenomRaw !== '-') {
        const ufDenominator = parseFloat(ufDenomRaw);
        if (!isNaN(ufDenominator)) {
          const nProject = normKey(ufProject);
          const nTask = normKey(ufTask);
          const nSubtask = normKey(ufSubtask);
          denominatorMap.uf[ufKey(ufProject, ufTask, ufSubtask)] = ufDenominator;
          if (!denominatorMap.ufRowsByProject[nProject]) denominatorMap.ufRowsByProject[nProject] = [];
          denominatorMap.ufRowsByProject[nProject].push({ task: nTask, subtask: nSubtask, denominator: ufDenominator });
        }
      }
    }

    console.log(`✅ Loaded ${Object.keys(denominatorMap.byProjectTask).length} project/task denominators, ${Object.keys(denominatorMap.uf).length} UF denominator rows`);
    return denominatorMap;
  } catch (err) {
    console.error("❌ Failed to fetch denominator sheet:", err.message);
    return { byProjectTask: {}, byGID: {}, rows: [], uf: {}, ufRowsByProject: {} };
  }
}

async function getDenominatorData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh &&
      denominatorCache.data &&
      denominatorCache.timestamp &&
      (now - denominatorCache.timestamp) < denominatorCache.cacheDuration) {
    return denominatorCache.data;
  }
  const data = await fetchDenominatorSheet();
  denominatorCache.data = data;
  denominatorCache.timestamp = now;
  return data;
}

/*
|--------------------------------------------------------------------------
| TASK FALLBACK GROUPS
|--------------------------------------------------------------------------
*/
const TASK_FALLBACK_035 = new Set([
  'offline_posm', 'posm_masking', 'posm_voting',
  'stitching', 'stitching_edit',
  'scene_recognition', 'scene_recognition_edit',
  'validation_warm_up'
]);

const TASK_FALLBACK_1 = new Set([
  'category_expert', 'voting_engine', 'masking', 'masking_engine',
  'masking_menu_items', 'masking_price_labels', 'offline_pricing',
  'pricing_voting', 'special_masking', 'validation', 'validation_edit',
  'offline_validation', 'voting', 'offline_voting'
]);

function taskFallback(normTask) {
  if (TASK_FALLBACK_035.has(normTask)) return 0.35;
  if (TASK_FALLBACK_1.has(normTask))   return 1;
  return 0;
}

function findUFDenominator(project, task, ufRowsByProject) {
  const rows = ufRowsByProject[normKey(project)];
  if (!rows || !rows.length) return undefined;

  const normTask = normKey(task);
  const equivSet = new Set(taskEquivalents(task));

  let exactMenu, exactAny, equivMenu, equivAny;
  for (const r of rows) {
    if (r.task === normTask) {
      if (r.subtask === 'menu') exactMenu = r.denominator;
      else if (exactAny === undefined) exactAny = r.denominator;
    } else if (equivSet.has(r.task)) {
      if (r.subtask === 'menu') equivMenu = r.denominator;
      else if (equivAny === undefined) equivAny = r.denominator;
    }
  }
  if (exactMenu !== undefined) return exactMenu;
  if (exactAny !== undefined) return exactAny;
  if (equivMenu !== undefined) return equivMenu;
  if (equivAny !== undefined) return equivAny;
  return undefined;
}

function findUFDenominatorBySubtask(project, task, subtask, ufRowsByProject) {
  const rows = ufRowsByProject[normKey(project)];
  if (!rows || !rows.length) return undefined;

  const normTask = normKey(task);
  const normSubtask = normKey(subtask);
  const equivSet = new Set(taskEquivalents(task));

  let exact, equiv;
  for (const r of rows) {
    if (r.subtask !== normSubtask) continue;
    if (r.task === normTask) exact = r.denominator;
    else if (equivSet.has(r.task) && equiv === undefined) equiv = r.denominator;
  }
  return exact !== undefined ? exact : equiv;
}

function findUFDenominatorByTaskAsSubtask(project, task, ufRowsByProject) {
  const rows = ufRowsByProject[normKey(project)];
  if (!rows || !rows.length) return undefined;

  const normTask = normKey(task);
  const equivSet = new Set(taskEquivalents(task));

  let exact, equiv;
  for (const r of rows) {
    if (r.subtask === normTask) exact = r.denominator;
    else if (equivSet.has(r.subtask) && equiv === undefined) equiv = r.denominator;
  }
  return exact !== undefined ? exact : equiv;
}

function lookupDenominator(project, task, denominatorData, templateName) {
  const normProject = normKey(project);
  const normTask    = normKey(task);
  const ufRowsByProject = denominatorData.ufRowsByProject || {};

  if (normProject === 'pges') {
    const subtask = normKey(templateName).includes('display') ? 'Repair Only' : 'Repair & Attribute';
    const ufValue = findUFDenominatorBySubtask(normProject, normTask, subtask, ufRowsByProject);
    if (ufValue !== undefined) return ufValue;
  } else if (UF_PRIORITY_PROJECTS.has(normProject)) {
    const tName = normKey(templateName);
    let uiSubtask = null;
    if (tName.includes('menu')) uiSubtask = 'Menu';
    else if (tName.includes('posm')) uiSubtask = 'offline_posm';

    if (uiSubtask) {
      const ufSubtaskValue = findUFDenominatorBySubtask(normProject, normTask, uiSubtask, ufRowsByProject);
      if (ufSubtaskValue !== undefined) return ufSubtaskValue;
    } else {
      const taskSubtaskValue = findUFDenominatorByTaskAsSubtask(normProject, normTask, ufRowsByProject);
      if (taskSubtaskValue !== undefined) return taskSubtaskValue;
    }

    const ufValue = findUFDenominator(normProject, normTask, ufRowsByProject);
    if (ufValue !== undefined) return ufValue;
  }

  const exactKey = `${normProject}||${normTask}`;
  if (denominatorData.byProjectTask[exactKey] !== undefined) {
    return denominatorData.byProjectTask[exactKey];
  }
  return taskFallback(normTask);
}

async function enrichWithDenominator(rows) {
  const denominatorData = await getDenominatorData();
  return rows.map(row => {
    const denominator = lookupDenominator(row.project_name, row.task_name, denominatorData, row.template_name);
    const wd = row.value * denominator;
    return { ...row, denominator, wd, count: row.value };
  });
}

/*
|--------------------------------------------------------------------------
| STAFF ROSTER (staff sheet -> Shift Sup / Team Leader -> Staff IDs)
|--------------------------------------------------------------------------
| Frontend eke parseStaffCsv ekama logic eka. Header names:
|   id      : "qat id" | "gid" | "...qat id..." | "staff ... id"
|   name    : "name"
|   shift   : "shift sup"
|   TL      : "teamlead" | "team lead" | "team_lead" | "tl"
| 5 min cache.
|--------------------------------------------------------------------------
*/
function parseCsvRows(csv) {
  const rows = [];
  const text = String(csv || "").replace(/^\uFEFF/, "");
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell.trim()); cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim()); cell = "";
      if (row.some(c => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some(c => c !== "")) rows.push(row);
  return rows;
}

const idKeyOf = (s) => String(s ?? "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().toUpperCase();
const lowerTrim = (s) => String(s ?? "").toLowerCase().trim();

function parseRosterCsv(csv) {
  const lines = parseCsvRows(csv);
  if (lines.length < 2) return [];

  const headers = lines[0].map(h => h.toLowerCase().trim());
  const idIdx = headers.findIndex(h =>
    h === "qat id" || h === "gid" || h.includes("qat id") || (h.includes("staff") && h.includes("id")));
  const nameIdx = headers.findIndex(h => h === "name");
  const shiftIdx = (() => {
    const e = headers.findIndex(h => h === "shift sup");
    return e !== -1 ? e : headers.findIndex(h => h.includes("shift sup"));
  })();
  const tlIdx = headers.findIndex(h => h === "teamlead" || h === "team lead" || h === "team_lead" || h === "tl");

  if (idIdx < 0) return [];

  const entries = [];
  const seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i];
    const id = String(cells[idIdx] ?? "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
    if (!id) continue;
    const key = idKeyOf(id);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      id,
      key,
      name: nameIdx >= 0 ? (cells[nameIdx] || "").trim() : "",
      shiftSup: shiftIdx >= 0 ? (cells[shiftIdx] || "").trim() : "",
      tl: tlIdx >= 0 ? (cells[tlIdx] || "").trim() : "",
    });
  }
  return entries;
}

let rosterCache = { data: null, ts: 0 };

async function getStaffRoster(force = false) {
  const now = Date.now();
  if (!force && rosterCache.data && now - rosterCache.ts < ROSTER_CACHE_MS) {
    return rosterCache.data;
  }
  const csv = await fetchStaffLookup();
  const data = parseRosterCsv(csv);
  rosterCache = { data, ts: now };
  console.log(`  📋 Roster loaded: ${data.length} staff`);
  return data;
}

// shiftSup: "" / "All" = filter nathuwa.  teamLeader: "" = filter nathuwa.
// -> Map<tlId, staffId[]>
function buildScopeFromRoster(roster, { shiftSup, teamLeader }) {
  const ss = lowerTrim(shiftSup);
  const tlWanted = lowerTrim(teamLeader);
  const useShift = ss && ss !== "all";

  const scope = new Map();
  for (const e of roster) {
    if (useShift && lowerTrim(e.shiftSup) !== ss) continue;
    if (tlWanted && lowerTrim(e.tl) !== tlWanted) continue;
    const tl = e.tl || "UNASSIGNED";
    if (!scope.has(tl)) scope.set(tl, []);
    scope.get(tl).push(e.id);
  }
  return scope;
}

// TL list ekakata (default TEAM_LEADERS wage) -> Map<tlId, staffId[]>  (roster eke thiyena ewa witharak)
function buildScopeForTLs(roster, tlList) {
  const wanted = new Map(tlList.map(t => [lowerTrim(t), t]));
  const scope = new Map();
  for (const e of roster) {
    const hit = wanted.get(lowerTrim(e.tl));
    if (!hit) continue;
    if (!scope.has(hit)) scope.set(hit, []);
    scope.get(hit).push(e.id);
  }
  return scope;
}

/*
|--------------------------------------------------------------------------
| FETCH — MODE 1: TL HOURLY (staff-ID based)
|--------------------------------------------------------------------------
*/
async function runStaffListQuery(staffIds, dateStr) {
  const query = buildQueryByStaffIdList(staffIds, dateStr);
  const response = await grafanaRequest('POST', QUERY_URL, query);
  const { jobId, location } = response.data.jobReference;
  const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;

  let result = await getQueryResults(resultUrl, 30);
  let rows = processResults(result);

  let pageToken = result.pageToken;
  let pages = 1;
  while (pageToken && pages < 100) {
    const pageRes = await grafanaRequest('GET', `${resultUrl}&pageToken=${encodeURIComponent(pageToken)}`);
    result = pageRes.data;
    rows = rows.concat(processResults(result));
    pageToken = result.pageToken;
    pages++;
  }
  return rows;
}

// scopeMap: Map<tlId, staffId[]>  ->  TLData[]  ({ tl_name, rows, total_rows, staff_ids, fetched_at })
async function fetchByScopeMap(scopeMap, dateStr) {
  const staffToTL = new Map();
  const allIds = [];
  for (const [tl, ids] of scopeMap) {
    for (const id of ids) {
      const k = idKeyOf(id);
      if (staffToTL.has(k)) continue;
      staffToTL.set(k, tl);
      allIds.push(id);
    }
  }

  const rowsByTL = new Map(Array.from(scopeMap.keys()).map(tl => [tl, []]));

  if (allIds.length > 0) {
    const chunks = [];
    for (let i = 0; i < allIds.length; i += STAFF_QUERY_CHUNK) chunks.push(allIds.slice(i, i + STAFF_QUERY_CHUNK));
    console.log(`  [TL] Querying ${allIds.length} staff ID(s) in ${chunks.length} chunk(s)`);

    const chunkRows = await Promise.all(chunks.map(c => runStaffListQuery(c, dateStr)));
    let rows = [].concat(...chunkRows);
    rows = await enrichWithDenominator(rows);

    for (const r of rows) {
      const tl = staffToTL.get(idKeyOf(r.staff_id));
      if (!tl) continue;
      rowsByTL.get(tl).push(r);
    }
  }

  const now = new Date().toISOString();
  return Array.from(scopeMap.entries()).map(([tl, ids]) => {
    const rows = rowsByTL.get(tl) || [];
    return { tl_name: tl, staff_ids: ids, rows, total_rows: rows.length, fetched_at: now };
  });
}

// LEGACY single TL (team_leader_staff_id) - roster eke TL nathnam fallback
async function fetchSingleTLLegacy(tlName, dateStr) {
  console.log(`  [TL-legacy] Fetching: tl_name="${tlName}" date="${dateStr || 'today'}"`);
  const query = buildQueryByTeamLeader(tlName, dateStr);
  const response = await grafanaRequest('POST', QUERY_URL, query);
  const jobId = response.data.jobReference.jobId;
  const location = response.data.jobReference.location;
  const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;
  const result = await getQueryResults(resultUrl);
  let rows = processResults(result);
  rows = await enrichWithDenominator(rows);
  console.log(`    Rows found: ${rows.length}`);
  return { tl_name: tlName, rows, total_rows: rows.length, fetched_at: new Date().toISOString() };
}

async function safeRoster() {
  try {
    return await getStaffRoster();
  } catch (err) {
    console.error("  ⚠️ Roster load failed:", err.message);
    return null;
  }
}

// Single TL: roster staff thiyenawanam staff IDs walin, nathnam legacy
async function fetchSingleTL(tlName, dateStr) {
  console.log(`  [TL] Fetching: tl_name="${tlName}" date="${dateStr || 'today'}"`);
  const roster = await safeRoster();
  if (roster) {
    const scope = buildScopeForTLs(roster, [tlName]);
    if (scope.size > 0) {
      const [entry] = await fetchByScopeMap(scope, dateStr);
      // tl_name eka user type karapu widihatama thiyenna
      return { ...entry, tl_name: tlName };
    }
  }
  return fetchSingleTLLegacy(tlName, dateStr);
}

// Default TL list: roster eken resolve wena ewa ekama query ekakin, nathi ewa legacy
async function fetchAllTeamLeaders(list, dateStr) {
  const tlList = (list && list.length) ? list : TEAM_LEADERS;
  console.log(`\n>>> [TL] Fetching ${tlList.length} Team Leader(s) via roster... date="${dateStr || 'today'}"`);

  const roster = await safeRoster();
  const resolved = roster ? buildScopeForTLs(roster, tlList) : new Map();
  const resolvedKeys = new Set(Array.from(resolved.keys()).map(lowerTrim));
  const missing = tlList.filter(t => !resolvedKeys.has(lowerTrim(t)));

  const results = [];

  if (resolved.size > 0) {
    try {
      results.push(...await fetchByScopeMap(resolved, dateStr));
    } catch (err) {
      console.error("  Error fetching roster-based TL data:", err.message);
      for (const tl of resolved.keys()) {
        results.push({ tl_name: tl, error: err.message, rows: [], total_rows: 0, fetched_at: new Date().toISOString() });
      }
    }
  }

  if (missing.length > 0) {
    console.log(`  [TL] ${missing.length} TL(s) not in roster -> legacy team_leader_staff_id query`);
    const legacy = await Promise.all(missing.map(async (tl) => {
      try {
        return await fetchSingleTLLegacy(tl, dateStr);
      } catch (err) {
        console.error(`  Error fetching ${tl}:`, err.message);
        return { tl_name: tl, error: err.message, rows: [], total_rows: 0, fetched_at: new Date().toISOString() };
      }
    }));
    results.push(...legacy);
  }

  return results;
}

// Shift Sup / Team Leader scope eka (dashboard filters)
async function fetchTeamLeadersByScope({ shiftSup, teamLeader }, dateStr) {
  console.log(`\n>>> [TL] Scope fetch: shift_sup="${shiftSup || '-'}" team_leader="${teamLeader || '-'}" date="${dateStr || 'today'}"`);
  const roster = await getStaffRoster();
  const scope = buildScopeFromRoster(roster, { shiftSup, teamLeader });
  const staffCount = Array.from(scope.values()).reduce((n, a) => n + a.length, 0);
  console.log(`  Scope resolved: ${scope.size} team leader(s), ${staffCount} staff`);
  if (scope.size === 0) return [];
  return fetchByScopeMap(scope, dateStr);
}

// Firebase key safe karanawa (. $ # [ ] / wage characters)
function fbKey(s) {
  return String(s || "UNASSIGNED").trim().replace(/[.$#\[\]\/]/g, "_") || "UNASSIGNED";
}

// TL Hourly -> Firebase.  Team Leader ID eka yatathe table (staff_ids + rows)
async function saveTLHourly(allData, meta) {
  const team_leaders = {};
  for (const d of allData) {
    team_leaders[fbKey(d.tl_name)] = {
      tl_name: d.tl_name,
      staff_ids: d.staff_ids || [],
      total_rows: d.total_rows || 0,
      fetched_at: d.fetched_at,
      ...(d.error ? { error: d.error } : {}),
      rows: d.rows || [],
    };
  }
  await saveToFirebase(FIREBASE_PATH_TL, {
    updated_at: new Date().toISOString(),
    date: meta.date || "today",
    filter_config: meta.filter_config || {},
    total_leaders: allData.length,
    team_leaders,
    // backward compatible array (tl_name + rows)
    data: allData.map(d => ({
      tl_name: d.tl_name,
      rows: d.rows || [],
      total_rows: d.total_rows || 0,
      fetched_at: d.fetched_at,
      ...(d.error ? { error: d.error } : {}),
    })),
  });
}

/*
|--------------------------------------------------------------------------
| FETCH — MODE 2: Staff ID (staff_id)
|--------------------------------------------------------------------------
*/
async function fetchSingleStaff(staffId, dateStr) {
  console.log(`  [STAFF] Fetching: staff_id="${staffId}" date="${dateStr || 'today'}"`);
  const query = buildQueryByStaffId(staffId, dateStr);
  const response = await grafanaRequest('POST', QUERY_URL, query);
  const jobId = response.data.jobReference.jobId;
  const location = response.data.jobReference.location;
  const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;
  const result = await getQueryResults(resultUrl);
  let rows = processResults(result);
  rows = await enrichWithDenominator(rows);
  console.log(`    Rows found: ${rows.length}`);
  return { staff_id: staffId, rows, total_rows: rows.length, fetched_at: new Date().toISOString() };
}

async function fetchAllStaff(staffIds, dateStr) {
  const list = (staffIds && staffIds.length) ? staffIds : TEAM_LEADERS;
  console.log(`\n>>> [STAFF] Fetching data for ${list.length} staff member(s)... date="${dateStr || 'today'}"`);
  const results = await Promise.all(
    list.map(async (staffId) => {
      try {
        return await fetchSingleStaff(staffId, dateStr);
      } catch (err) {
        console.error(`  Error fetching ${staffId}:`, err.message);
        return { staff_id: staffId, error: err.message, rows: [], total_rows: 0, fetched_at: new Date().toISOString() };
      }
    })
  );
  return results;
}

/*
|--------------------------------------------------------------------------
| FETCH — MODE 3: Project + Task filtered
|--------------------------------------------------------------------------
*/
async function fetchFilteredByProjectTask(project, task, dateStr) {
  console.log(`\n>>> [FILTERED] Fetching: project="${project}" task="${task}" date="${dateStr || 'today'}"`);
  const query = buildQueryByProjectTask(project, task, dateStr);
  const response = await grafanaRequest('POST', QUERY_URL, query);
  const jobId = response.data.jobReference.jobId;
  const location = response.data.jobReference.location;
  const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;
  const result = await getQueryResults(resultUrl);
  const rows = processResults(result);
  console.log(`  Rows found: ${rows.length}`);
  return rows;
}

/*
|--------------------------------------------------------------------------
| FETCH — MODE 4: Planning
|--------------------------------------------------------------------------
*/
async function fetchPlanningActual(entry, dateStr) {
  const rows = await fetchFilteredByProjectTask(entry.project_name, entry.task_name, dateStr);
  const actual = rows.reduce((sum, r) => sum + (Number(r.value) || 0), 0);
  const target = Number(entry.target) || 0;
  const percentage = target > 0 ? Math.round((actual / target) * 1000) / 10 : 0;

  const staffMap = {};
  rows.forEach((r) => {
    const sid = r.staff_id || "unknown";
    staffMap[sid] = (staffMap[sid] || 0) + (Number(r.value) || 0);
  });
  const staff_breakdown = Object.entries(staffMap)
    .map(([staff_id, value]) => ({ staff_id, value }))
    .sort((a, b) => b.value - a.value);

  return { actual, percentage, staff_breakdown };
}

async function refreshAllPlanning(dateStr) {
  const planningMap = (await getFromFirebase(FIREBASE_PATH_PLANNING)) || {};
  const ids = Object.keys(planningMap);
  console.log(`\n>>> [PLANNING] Refreshing ${ids.length} planning item(s)... date="${dateStr || 'today'}"`);

  const updated = {};
  await Promise.all(
    ids.map(async (id) => {
      const entry = planningMap[id] || {};
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
      } catch (err) {
        console.error(`  Error refreshing planning id=${id}:`, err.message);
        updated[id] = { ...entry, error: err.message, last_fetched_at: new Date().toISOString() };
      }
    })
  );

  await saveToFirebase(FIREBASE_PATH_PLANNING, updated);
  return updated;
}

/*
|--------------------------------------------------------------------------
| FETCH — MODE 5: Project Outflow
|--------------------------------------------------------------------------
*/
async function fetchOutflow(fromStr, toStr) {
  const label = fromStr && toStr ? (fromStr === toStr ? fromStr : `${fromStr}..${toStr}`) : "today";
  console.log(`\n>>> [OUTFLOW] Fetching project outflow... date="${label}"`);
  const query = buildQueryOutflow(fromStr, toStr);
  const response = await grafanaRequest('POST', QUERY_URL, query);
  const jobId = response.data.jobReference.jobId;
  const location = response.data.jobReference.location;
  const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;

  const isMultiDay = !!(fromStr && toStr && fromStr !== toStr);
  let result = await getQueryResults(resultUrl, isMultiDay ? 30 : 10);
  let rows = processOutflowResults(result);

  let pageToken = result.pageToken;
  let pages = 1;
  while (pageToken && pages < 50) {
    const pageRes = await grafanaRequest(
      'GET',
      `${resultUrl}&pageToken=${encodeURIComponent(pageToken)}`
    );
    result = pageRes.data;
    rows = rows.concat(processOutflowResults(result));
    pageToken = result.pageToken;
    pages++;
  }

  console.log(`  Rows found: ${rows.length}`);
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
    console.log("  ⏭️ [OUTFLOW] Previous refresh still running, skipping this tick");
    return;
  }
  outflowRunning = true;
  try {
    await refreshOutflow();
    console.log("✅ [OUTFLOW] Updated:", new Date().toLocaleTimeString());
  } catch (err) {
    console.error("❌ [OUTFLOW] Auto refresh error:", err.message);
  } finally {
    outflowRunning = false;
  }
}

function startOutflowAutoLoop() {
  if (!OUTFLOW_AUTO_INTERVAL_SEC || OUTFLOW_AUTO_INTERVAL_SEC <= 0) {
    console.log("  ⏸️ [OUTFLOW] Auto refresh disabled (OUTFLOW_INTERVAL_SEC=0)");
    return;
  }
  const loop = async () => {
    await autoRefreshOutflowOnce();
    setTimeout(loop, OUTFLOW_AUTO_INTERVAL_SEC * 1000);
  };
  loop();
}

/*
|--------------------------------------------------------------------------
| FETCH — MODE 7: Cancellation
|--------------------------------------------------------------------------
*/
async function runBigQuery(query, maxTries = 30) {
  let response;
  try {
    response = await grafanaRequest('POST', QUERY_URL, query);
  } catch (err) {
    const bq = err.response && err.response.data && err.response.data.error;
    throw new Error(bq && bq.message ? `BigQuery: ${bq.message}` : err.message);
  }
  const { jobId, location } = response.data.jobReference;
  const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;

  let result = await getQueryResults(resultUrl, maxTries);
  let rows = processGenericResults(result);

  let pageToken = result.pageToken;
  let pages = 1;
  while (pageToken && pages < 100) {
    const pageRes = await grafanaRequest(
      'GET',
      `${resultUrl}&pageToken=${encodeURIComponent(pageToken)}`
    );
    rows = rows.concat(processGenericResults(pageRes.data));
    pageToken = pageRes.data.pageToken;
    pages++;
  }
  return rows;
}

async function fetchCancellation(staffIds, dateStr) {
  console.log(`\n>>> [CANCEL] staff_ids=${staffIds && staffIds.length ? staffIds.join(",") : "ALL"} date="${dateStr || 'all'}"`);
  const rows = await runBigQuery(buildQueryCancellation(staffIds, dateStr));
  console.log(`  Rows found: ${rows.length}`);
  return rows;
}

/*
|--------------------------------------------------------------------------
| MODE 6: QUEUE MONITOR
|--------------------------------------------------------------------------
*/
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
  { path: "offline_voting", name: "offline voting" }
];

const QUEUE_PROJECT_NAME_RE = /^[a-z0-9_-]+$/;

function formatDuration(seconds) {
  seconds = Math.floor(Number(seconds));
  if (isNaN(seconds)) return null;

  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return `${hours}h ${mins}m`;

  const days = Math.floor(hours / 24);
  const hrs = hours % 24;
  if (days < 7) return `${days}d ${hrs}h`;

  const weeks = Math.floor(days / 7);
  const remainingDays = days % 7;
  return `${weeks}w ${remainingDays}d`;
}

async function grafanaRender(body, retryCount = 0) {
  let usedSession = null;
  try {
    const headers = await getGrafanaHeaders();
    usedSession = grafanaSession;
    const res = await axios.post(QUEUE_GRAFANA_URL, body, {
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30000
    });
    if (!Array.isArray(res.data)) {
      const e = new Error("Unexpected Grafana render response (session expired?)");
      e.badSession = true;
      throw e;
    }
    return res.data;
  } catch (error) {
    const status = error.response && error.response.status;
    const expired = status === 401 || status === 403 || error.badSession;
    if (expired && retryCount < 2) {
      console.warn("⚠️ [QUEUE] Session expired or invalid. Refreshing Grafana session...");
      if (grafanaSession === usedSession) grafanaSession = null;
      return grafanaRender(body, retryCount + 1);
    }
    throw error;
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
    for (const [key, val] of Object.entries(data)) {
      if (val === null || val === undefined) continue;

      let raw;
      if (typeof val === "string") raw = val;
      else if (typeof val === "object" && val.name) raw = String(val.name);
      else raw = key;

      const name = raw.trim().toLowerCase();
      if (!name) continue;

      if (!QUEUE_PROJECT_NAME_RE.test(name)) {
        if (!queueWarnedNames.has(name)) {
          queueWarnedNames.add(name);
          console.warn(`  ⚠️ [QUEUE] Skipping invalid project name in Server Projects: "${raw}"`);
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
  const res = await axios.get(QUEUE_FIREBASE_URL, { timeout: 30000 });
  queueMirror = (res.data && typeof res.data === "object") ? res.data : {};
  console.log(`  📥 [QUEUE] Loaded ${Object.keys(queueMirror).length} existing project(s) from Firebase`);
}

async function fetchQueueProject(project) {
  const params = new URLSearchParams();
  for (const m of QUEUE_METRICS) {
    params.append("target", `alias(prod.gauges.selector.queue.${m.path}.${project}.total,'${m.name} - Total')`);
    params.append("target", `alias(aliasByNode(prod.gauges.selector.queue.${m.path}.${project}.oldestTask,4),'${m.name} - Oldest Task')`);
  }
  params.append("from", "-1h");
  params.append("until", "now");
  params.append("format", "json");

  const json = await grafanaRender(params.toString());
  const projectData = {};

  for (const series of json) {
    if (!series || !Array.isArray(series.datapoints)) continue;

    const validPoints = series.datapoints.filter(dp => dp[0] !== null);
    const last = validPoints.pop();
    if (!last) continue;

    const value = String(last[0]);
    const timestamp = new Date(last[1] * 1000).toISOString();

    const isOldest = series.target.includes("Oldest Task");
    const metricName = series.target
      .replace(" - Total", "")
      .replace(" - Oldest Task", "");

    if (!projectData[metricName]) {
      projectData[metricName] = {
        current: null,
        duration: null,
        durationRaw: null,
        lastUpdated: timestamp
      };
    }

    if (isOldest) {
      projectData[metricName].duration = formatDuration(value);
      projectData[metricName].durationRaw = value;
    } else {
      projectData[metricName].current = value;
    }
  }

  return projectData;
}

function mergeQueueProject(oldProject, newData) {
  const old = oldProject || {};
  const merged = {};
  let changed = false;

  for (const [metric, nm] of Object.entries(newData)) {
    const om = old[metric];
    let previous = om ? (om.previous ?? null) : null;
    const oldCur = om ? (om.current ?? null) : null;
    const newCur = nm.current ?? null;

    if (!om) {
      changed = true;
    } else if (oldCur !== newCur) {
      if (oldCur !== null) previous = oldCur;
      changed = true;
    }

    merged[metric] = {
      current: newCur,
      duration: nm.duration,
      durationRaw: nm.durationRaw,
      previous,
      lastUpdated: nm.lastUpdated
    };
  }

  if (Object.keys(old).some(k => !(k in newData))) changed = true;

  return { merged, changed };
}

async function runPool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      await worker(items[idx], idx);
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
  lastError: null
};

async function runQueueCycle() {
  if (queueState.running) return { skipped: true, reason: "previous cycle still running" };

  queueState.running = true;
  const started = Date.now();

  try {
    const projects = await getQueueProjects();
    if (!projects.length) {
      console.log("  ⚠️ [QUEUE] No projects found in Server Projects - nothing to monitor");
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

    await runPool(projects, QUEUE_CONCURRENCY, async (project) => {
      try {
        const newData = await fetchQueueProject(project);
        const oldProject = queueMirror[project];

        if (Object.keys(newData).length === 0) {
          if (oldProject) updates[project] = null;
          return;
        }

        const { merged, changed } = mergeQueueProject(oldProject, newData);
        const heartbeatDue =
          QUEUE_HEARTBEAT_SEC > 0 &&
          Date.now() - (queueLastPush[project] || 0) >= QUEUE_HEARTBEAT_SEC * 1000;

        if (changed || !oldProject || heartbeatDue) {
          updates[project] = merged;
        }
      } catch (err) {
        errors++;
        lastErr = err.message;
        console.error(`  ❌ [QUEUE] Error in ${project}:`, err.message);
      }
    });

    const projectSet = new Set(projects);
    for (const key of Object.keys(queueMirror)) {
      if (!projectSet.has(key)) updates[key] = null;
    }

    const updateKeys = Object.keys(updates);
    if (updateKeys.length > 0) {
      await axios.patch(QUEUE_FIREBASE_URL, updates, { timeout: 30000 });

      const now = Date.now();
      let removed = 0;
      for (const key of updateKeys) {
        if (updates[key] === null) {
          delete queueMirror[key];
          delete queueLastPush[key];
          removed++;
        } else {
          queueMirror[key] = updates[key];
          queueLastPush[key] = now;
        }
      }
      console.log(
        `🚀 [QUEUE] Firebase updated: ${updateKeys.length - removed} project(s) pushed` +
        (removed ? `, ${removed} removed` : "") +
        (errors ? `, ${errors} error(s)` : "")
      );
    }

    queueState.lastProjectCount = projects.length;
    queueState.lastPushedCount = updateKeys.length;
    queueState.lastErrorCount = errors;
    queueState.lastError = lastErr;
    queueState.lastRunAt = new Date().toISOString();
    queueState.lastDurationMs = Date.now() - started;

    return { projects: projects.length, pushed: updateKeys.length, errors };
  } catch (err) {
    queueState.lastError = err.message;
    queueState.lastRunAt = new Date().toISOString();
    queueState.lastDurationMs = Date.now() - started;
    throw err;
  } finally {
    queueState.running = false;
  }
}

function startQueueAutoLoop() {
  if (!QUEUE_INTERVAL_SEC || QUEUE_INTERVAL_SEC <= 0) {
    console.log("  ⏸️ [QUEUE] Auto refresh disabled (QUEUE_INTERVAL_SEC=0)");
    return;
  }
  const loop = async () => {
    try {
      await runQueueCycle();
    } catch (err) {
      console.error("❌ [QUEUE] Cycle error:", err.message);
    }
    setTimeout(loop, QUEUE_INTERVAL_SEC * 1000);
  };
  loop();
}

/*
|--------------------------------------------------------------------------
| STAFF LOOKUP
|--------------------------------------------------------------------------
*/
async function fetchStaffLookup() {
  try {
    const response = await axios.get(STAFF_SHEET_URL, { responseType: 'text', timeout: 30000 });
    return response.data;
  } catch (err) {
    console.error('Staff lookup error:', err.message);
    throw new Error('Failed to fetch staff sheet: ' + err.message);
  }
}

/*
|--------------------------------------------------------------------------
| PROJECT/TASK LOOKUP (raw records)
|--------------------------------------------------------------------------
*/
async function fetchProjectTaskLookup() {
  try {
    console.log("📊 Fetching project/task lookup data...");
    const response = await axios.get(PROJECT_TASK_SHEET_URL(), {
      responseType: 'text',
      timeout: 30000
    });

    const lines = response.data.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) return [];

    const splitLine = (line) =>
      line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));

    const headers = splitLine(lines[0]).map(h => h.toLowerCase());
    const records = [];

    for (let i = 1; i < lines.length; i++) {
      const cells = splitLine(lines[i]);
      const record = {};
      headers.forEach((header, idx) => {
        record[header] = cells[idx] || '';
      });
      records.push(record);
    }

    console.log(`✅ Loaded ${records.length} project/task lookup records`);
    return records;
  } catch (err) {
    console.error("❌ Failed to fetch project/task lookup:", err.message);
    throw new Error("Failed to fetch project/task sheet: " + err.message);
  }
}

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/
function parseIdsParam(query) {
  const raw = query.staff_ids || query.staff_id || query.tl_names || query.tl_name;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/*
|--------------------------------------------------------------------------
| MODE 8: TRAX TEAM MONITOR  (https://smart-prod.trax-cloud.com)
|--------------------------------------------------------------------------
| Headless browser (Playwright) logs in to Trax, then reads the locked tasks
| for whichever project name the dashboard asks for.
|   GET /monitor                  -> dashboard page (dashboard.html)
|   GET /monitor/project/<name>   -> locked tasks for one project (JSON)
|   GET /monitor/health           -> login status (+ last login error)
|   GET /monitor/health?retry=1   -> also forces a fresh login attempt
|
| HTTP status codes returned by /monitor/project/<name>:
|   200  ok
|   400  invalid project name
|   403  your Trax account has no access to this project
|   404  project not found on Trax
|   503  server cannot reach Trax (browser failed to start / login failed)
|        -> body has { error, code, hint } with the REAL reason
|   502  Trax answered with something unexpected (HTTP 5xx, bad JSON ...)
|
| SLA: from TRAX_SLA_MAP, otherwise 24 hours.
|--------------------------------------------------------------------------
*/
const TRAX_BASE = "https://smart-prod.trax-cloud.com";
const TRAX_HOME_URL = `${TRAX_BASE}/home`;
const TRAX_HEADLESS = process.env.TRAX_HEADLESS !== "false";
const TRAX_CACHE_MS = Number(process.env.TRAX_CACHE_SEC ?? 4) * 1000;              // per-project response cache
const TRAX_LOGIN_COOLDOWN_MS = Number(process.env.TRAX_LOGIN_COOLDOWN_SEC ?? 30) * 1000; // wait after a failed login

const TRAX_SLA_MAP = {
  cbcdairyil: 20,
  inbevci: 15,
  inbevnl: 15,
  marsbh: 15,
  marskw: 15,
  marsom: 15,
  marsqa: 15,
  marsuae: 15,
  risparkwinede: 15,
  straussdryil: 15,
  straussfritolayil: 60,
  straussil: 15,
  tevade: 20,
  tevapl: 20,
  tevaru: 20,
};
const TRAX_DEFAULT_SLA = 24 * 60;
const traxGetSla = (name) => TRAX_SLA_MAP[name] ?? TRAX_DEFAULT_SLA;

const TRAX_ALLOWED_TASK_TYPES = ["voting_engine", "stitching", "validation", "voting"];
const TRAX_SLA_TYPES = ["validation", "stitching"];

// session expired -> relogin and retry once
class TraxAuthError extends Error {}
// Trax itself said 403 / 404 -> pass the same status to the dashboard
class TraxHttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
// we could not even get logged in (browser missing, wrong password, captcha ...)
class TraxUnavailableError extends Error {
  constructor(message, hint) { super(message); this.hint = hint || null; }
}

let traxBrowser = null;
let traxContext = null;
let traxPage = null;
let traxLoggedIn = false;
let traxLoggingIn = null;
let traxLoginError = null;       // { message, hint, at }
let traxLoginFailedAt = 0;
const traxStartTimes = new Map();

const traxFmt = (s) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;

function traxHintFor(message) {
  const m = String(message || "");
  if (/Executable doesn't exist|browserType\.launch|playwright install/i.test(m)) {
    return "Chromium is not installed on the server. Deploy with the provided Dockerfile (it ships Chromium and its system libraries).";
  }
  if (/error while loading shared libraries|libnss3|libatk|libgbm|libasound/i.test(m)) {
    return "Chromium system libraries are missing. Deploy with the provided Dockerfile.";
  }
  if (/playwright not installed|Cannot find module 'playwright'/i.test(m)) {
    return "The playwright package is not installed. Run npm install.";
  }
  if (/Target (page, context or browser )?has been closed|crash|out of memory|SIGKILL/i.test(m)) {
    return "Chromium crashed, most likely out of memory on a small instance. Use a bigger instance or keep only one dashboard tab open.";
  }
  if (/login failed|password field still visible/i.test(m)) {
    return "Trax rejected the login. Check TRAX_USER / TRAX_PASS (or the account needs MFA / captcha).";
  }
  return null;
}

// Is Chromium actually installed on this machine? (shown in /monitor/health and in the startup log)
function traxChromiumInfo() {
  try {
    const { chromium } = require("playwright");
    const p = chromium.executablePath();
    return { installed: fs.existsSync(p), path: p };
  } catch (e) {
    return { installed: false, path: null, error: e.message.split("\n")[0] };
  }
}

async function traxResetBrowser() {
  traxLoggedIn = false;
  try { if (traxPage) await traxPage.close(); } catch (e) {}
  try { if (traxContext) await traxContext.close(); } catch (e) {}
  try { if (traxBrowser) await traxBrowser.close(); } catch (e) {}
  traxPage = null;
  traxContext = null;
  traxBrowser = null;
}

async function traxEnsureBrowser() {
  if (traxContext && traxBrowser && traxBrowser.isConnected()) return;
  if (traxBrowser) await traxResetBrowser();   // browser died -> start clean
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (e) {
    throw new Error("playwright not installed. Run: npm install playwright && npx playwright install chromium");
  }
  traxBrowser = await chromium.launch({
    headless: TRAX_HEADLESS,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions"],
  });
  traxBrowser.on("disconnected", () => {
    console.error("[TRAX] Browser disconnected");
    traxLoggedIn = false;
    traxBrowser = null;
    traxContext = null;
    traxPage = null;
  });
  traxContext = await traxBrowser.newContext();
}

function traxLogin() {
  if (traxLoggingIn) return traxLoggingIn;
  traxLoggingIn = (async () => {
    try {
      await traxEnsureBrowser();
      console.log("[TRAX] Logging in...");
      traxLoggedIn = false;
      if (traxPage) await traxPage.close().catch(() => {});
      traxPage = await traxContext.newPage();
      // login only needs HTML/JS/CSS: skip images, fonts and media to save memory on small instances
      await traxPage.route("**/*", (route) => {
        const t = route.request().resourceType();
        return t === "image" || t === "media" || t === "font" ? route.abort() : route.continue();
      }).catch(() => {});
      await traxPage.goto(TRAX_HOME_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await traxPage.waitForSelector('input[type="password"]', { timeout: 20000 }).catch(() => {});

      const pass = await traxPage.$('input[type="password"]');
      if (pass) {
        const user = await traxPage.$(
          'input[type="email"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i], input[type="text"]'
        );
        if (!user) throw new Error("Username field not found on the Trax login page");
        await user.fill(TRAX_USER);
        await pass.fill(TRAX_PASS);
        await Promise.all([
          traxPage.waitForLoadState("networkidle").catch(() => {}),
          traxPage.click('button[type="submit"], input[type="submit"]').catch(async () => {
            await traxPage.getByRole("button", { name: /log\s?in|sign\s?in/i }).click();
          }),
        ]);
        await traxPage.waitForTimeout(4000);
      }

      if (await traxPage.$('input[type="password"]')) {
        await traxPage.screenshot({ path: "trax-login-failed.png" }).catch(() => {});
        throw new Error("Trax login failed (password field still visible). See trax-login-failed.png (MFA/captcha/wrong password?)");
      }
      traxLoggedIn = true;
      traxLoginError = null;
      traxLoginFailedAt = 0;
      console.log("[TRAX] Login OK");
    } catch (e) {
      traxLoggedIn = false;
      traxLoginFailedAt = Date.now();
      traxLoginError = { message: e.message.split("\n")[0], hint: traxHintFor(e.message), at: new Date().toISOString() };
      console.error("[TRAX] Login failed:", e.message);
      throw new TraxUnavailableError(traxLoginError.message, traxLoginError.hint);
    }
  })().finally(() => { traxLoggingIn = null; });
  return traxLoggingIn;
}

async function traxFetchOnce(project) {
  if (!traxContext) throw new TraxAuthError("no browser session");
  let r;
  try {
    r = await traxContext.request.get(`${TRAX_BASE}/api/team-leader/${project}/lockedTasks`, {
      timeout: 12000,
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    throw new Error(`Could not reach Trax: ${e.message.split("\n")[0]}`);
  }
  const status = r.status();
  const ct = r.headers()["content-type"] || "";
  if (status === 401) throw new TraxAuthError("session expired (401)");
  if (status === 403) throw new TraxHttpError(403, `No access to project "${project}" with this Trax account (403)`);
  if (status === 404) throw new TraxHttpError(404, `Project "${project}" not found on Trax (404)`);
  if (!r.ok()) throw new Error(`Trax returned HTTP ${status}`);
  const text = await r.text();
  if (!text.trim()) return [];
  if (!ct.includes("json") && text.trim().startsWith("<")) throw new TraxAuthError("got login page instead of data");
  try {
    const j = JSON.parse(text);
    return Array.isArray(j) ? j : [];
  } catch (e) {
    throw new Error("Trax returned invalid JSON");
  }
}

async function traxEnsureLoggedIn() {
  if (traxLoggedIn) return;
  // do not hammer Trax / relaunch Chromium on every poll after a failure
  if (traxLoginError && Date.now() - traxLoginFailedAt < TRAX_LOGIN_COOLDOWN_MS) {
    throw new TraxUnavailableError(traxLoginError.message, traxLoginError.hint);
  }
  await traxLogin();
}

async function traxFetchProject(project) {
  await traxEnsureLoggedIn();
  try {
    return await traxFetchOnce(project);
  } catch (e) {
    if (e instanceof TraxAuthError) {
      traxLoggedIn = false;
      await traxLogin();
      return await traxFetchOnce(project);
    }
    throw e;
  }
}

function traxProcessRows(raw, project, slaMins) {
  const now = Date.now();
  const live = new Set();
  const rows = [];
  for (const td of raw) {
    if (!TRAX_ALLOWED_TASK_TYPES.includes(td.taskType)) continue;
    if (!td.lockedBy || td.lockedBy === "undefined" || td.lockedBy === "N/A") continue;
    const key = `${project}|${td.lockedBy}_${td.taskType}_${td.objectId}_${td.uuid}`;
    live.add(key);
    if (!traxStartTimes.has(key)) traxStartTimes.set(key, td.pullDate ? new Date(td.pullDate).getTime() : now);
    const dur = Math.floor((now - traxStartTimes.get(key)) / 1000);
    const created = td.insertDate ? new Date(td.insertDate).getTime() : now;
    const tracked = TRAX_SLA_TYPES.includes(td.taskType);
    const remaining = tracked ? slaMins * 60 - Math.floor((now - created) / 1000) : null;
    rows.push({
      email: td.lockedBy,
      taskType: td.taskType,
      project,
      objectId: td.objectId || "N/A",
      durationSeconds: dur,
      duration: traxFmt(dur),
      remainingSeconds: remaining,
      slaMinutes: tracked ? slaMins : null,
      created: new Date(created).toISOString(),
    });
  }
  for (const k of traxStartTimes.keys()) {
    if (k.startsWith(project + "|") && !live.has(k)) traxStartTimes.delete(k);
  }
  return rows;
}

// Per-project cache + in-flight de-duplication: 10 open dashboards = 1 Trax request per interval.
const traxCache = new Map();   // project -> { ts, payload, promise }

async function traxGetProjectPayload(name) {
  const now = Date.now();
  const hit = traxCache.get(name);
  if (hit) {
    if (hit.promise) return hit.promise;
    if (hit.payload && now - hit.ts < TRAX_CACHE_MS) return hit.payload;
  }

  const promise = (async () => {
    const sla = traxGetSla(name);
    const raw = await traxFetchProject(name);
    return {
      project: name,
      sla,
      updatedAt: new Date().toISOString(),
      tasks: traxProcessRows(raw, name, sla),
    };
  })();

  traxCache.set(name, { ts: now, payload: null, promise });
  try {
    const payload = await promise;
    traxCache.set(name, { ts: Date.now(), payload, promise: null });
    return payload;
  } catch (e) {
    traxCache.delete(name);        // never cache errors
    throw e;
  } finally {
    if (traxCache.size > 100) {    // keep memory bounded
      for (const [k, v] of traxCache) {
        if (!v.promise && Date.now() - v.ts > 60000) traxCache.delete(k);
      }
    }
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

// true => request handled, false => fall through to the other routes
async function handleTraxMonitor(req, res, pathname, query) {
  if (req.method !== "GET") return false;

  if (pathname === "/monitor" || pathname === "/monitor/") {
    fs.readFile(TRAX_DASHBOARD_PATH, "utf8", (err, html) => {
      if (err) {
        sendJson(res, 500, { error: "dashboard.html not found next to server.js" });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    });
    return true;
  }

  if (pathname === "/monitor/health") {
    if (query && query.retry && !traxLoggedIn && !traxLoggingIn) {
      traxLoginFailedAt = 0;
      await traxLogin().catch(() => {});   // result is reflected in loggedIn / lastError below
    }
    sendJson(res, 200, {
      loggedIn: traxLoggedIn,
      loggingIn: !!traxLoggingIn,
      browserRunning: !!(traxBrowser && traxBrowser.isConnected()),
      lastError: traxLoginError,
      chromium: traxChromiumInfo(),
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      node: process.version,
    });
    return true;
  }

  if (pathname.startsWith("/monitor/project/")) {
    let name;
    try {
      name = decodeURIComponent(pathname.slice("/monitor/project/".length)).trim().toLowerCase();
    } catch (e) {
      name = "";
    }
    if (!/^[a-z0-9_-]{1,60}$/.test(name)) {
      sendJson(res, 400, { error: "Invalid project name" });
      return true;
    }
    try {
      sendJson(res, 200, await traxGetProjectPayload(name));
    } catch (e) {
      console.error("[TRAX] Request error:", name, e.message);
      if (e instanceof TraxHttpError) {
        sendJson(res, e.status, { error: e.message, code: `trax_${e.status}` });
      } else if (e instanceof TraxUnavailableError) {
        sendJson(res, 503, { error: e.message, code: "trax_unavailable", hint: e.hint });
      } else {
        sendJson(res, 502, { error: e.message, code: "trax_upstream", hint: traxHintFor(e.message) });
      }
    }
    return true;
  }

  return false;
}

function startTraxMonitor() {
  console.log("[TRAX] Chromium check:", JSON.stringify(traxChromiumInfo()), "| node", process.version);
  traxLogin().catch((e) => console.error("[TRAX] Initial login failed (will retry on request):", e.message));
  setInterval(() => {
    if (traxPage && traxLoggedIn) traxPage.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  }, 10 * 60 * 1000);
}

async function shutdown() {
  try { if (traxBrowser) await traxBrowser.close(); } catch (e) {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);


/*
|--------------------------------------------------------------------------
| HTTP SERVER WITH CORS
|--------------------------------------------------------------------------
*/
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

  if (!AUTH_EXEMPT_PATHS.includes(pathname) && !authenticate(req)) {
    console.log(`  ❌ Unauthorized: ${req.url}`);
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="QAT Server"',
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  try {
    // MODE 8: Trax Team Monitor (/monitor, /monitor/project/<name>, /monitor/health)
    if (await handleTraxMonitor(req, res, pathname, query)) return;

    // Health check
    if (pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        service: "QAT Server - Unified (TL / Staff ID / Project-Task / Planning / Outflow / Queue Monitor / Cancellation / Trax Team Monitor)",
        time: new Date().toISOString(),
        cors: "enabled",
        outflow_auto_interval_sec: OUTFLOW_AUTO_INTERVAL_SEC,
        queue_auto_interval_sec: QUEUE_INTERVAL_SEC,
        trax_logged_in: traxLoggedIn
      }));
      return;
    }

    // -------------------------------------------------------------
    // MODE 1: TEAM LEADER (TL HOURLY)
    //   /fetch-all                                   -> default TEAM_LEADERS (roster staff IDs)
    //   /fetch-all?shift_sup=Thevidu                 -> Shift Sup ge okkoma staff
    //   /fetch-all?shift_sup=All                     -> roster eke okkoma staff
    //   /fetch-all?shift_sup=Thevidu&team_leader=G1-OTL -> eka TL ge staff
    //   /fetch-all?tl_names=A,B                      -> TL list (roster staff IDs)
    // -------------------------------------------------------------
    if (pathname === "/fetch-all" && req.method === "GET" && (!query.mode || query.mode === "tl")) {
      const dateStr = parseDateParam(query);
      const shiftSup = query.shift_sup ? String(query.shift_sup).trim() : "";
      const teamLeader = query.team_leader ? String(query.team_leader).trim() : "";
      const requestedIds = parseIdsParam(query);

      let allData;
      let filterConfig;

      if (shiftSup || teamLeader) {
        allData = await fetchTeamLeadersByScope({ shiftSup, teamLeader }, dateStr);
        filterConfig = { shift_sup: shiftSup || "All", team_leader: teamLeader || "All", date: dateStr || "today" };
      } else {
        allData = await fetchAllTeamLeaders(requestedIds, dateStr);
        filterConfig = { tl_names: requestedIds.length ? requestedIds : TEAM_LEADERS, date: dateStr || "today" };
      }

      await saveTLHourly(allData, { date: dateStr || "today", filter_config: filterConfig });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        mode: "tl",
        date: dateStr || "today",
        filter_config: filterConfig,
        data: allData,
        total_leaders: allData.length,
        updated_at: new Date().toISOString()
      }));
      return;
    }

    // -------------------------------------------------------------
    // MODE 2: STAFF ID — /fetch-all?mode=staff&date=YYYY-MM-DD
    // -------------------------------------------------------------
    if (pathname === "/fetch-all" && req.method === "GET" && query.mode === "staff") {
      const requestedIds = parseIdsParam(query);
      const dateStr = parseDateParam(query);
      const allData = await fetchAllStaff(requestedIds, dateStr);
      await saveToFirebase(FIREBASE_PATH_STAFF, {
        updated_at: new Date().toISOString(),
        date: dateStr || "today",
        total_leaders: allData.length,
        data: allData
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        mode: "staff",
        date: dateStr || "today",
        data: allData,
        total_leaders: allData.length,
        staff_ids: requestedIds.length ? requestedIds : TEAM_LEADERS,
        updated_at: new Date().toISOString()
      }));
      return;
    }

    // -------------------------------------------------------------
    // Single fetch — /fetch?tl_name=...  OR  /fetch?staff_id=...
    // -------------------------------------------------------------
    if (pathname === "/fetch" && req.method === "GET") {
      const dateStr = parseDateParam(query);

      if (query.staff_id) {
        const staffId = String(query.staff_id).trim();
        const data = await fetchSingleStaff(staffId, dateStr);
        await saveToFirebase(FIREBASE_PATH_STAFF, {
          updated_at: new Date().toISOString(),
          date: dateStr || "today",
          total_rows: data.total_rows,
          filter_config: { staff_id: staffId, date: dateStr || "today" },
          data: data.rows,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          mode: "staff",
          date: dateStr || "today",
          rows: data.rows,
          total: data.total_rows,
          staff_id: staffId,
          updated_at: new Date().toISOString(),
        }));
        return;
      }

      const tlName = String(query.tl_name || TEAM_LEADERS[0]).trim();
      const data = await fetchSingleTL(tlName, dateStr);
      await saveTLHourly([data], {
        date: dateStr || "today",
        filter_config: { tl_name: tlName, date: dateStr || "today" },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        mode: "tl",
        date: dateStr || "today",
        rows: data.rows,
        total: data.total_rows,
        tl_name: tlName,
        updated_at: new Date().toISOString(),
      }));
      return;
    }

    // -------------------------------------------------------------
    // MODE 3: PROJECT + TASK FILTERED
    // -------------------------------------------------------------
    if (pathname === "/fetch-filtered" && req.method === "GET") {
      const project = (query.project || "").trim();
      const task = (query.task || "").trim();
      const dateStr = parseDateParam(query);

      if (!project || !task) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "project and task are both required" }));
        return;
      }

      const rows = await fetchFilteredByProjectTask(project, task, dateStr);
      await saveToFirebase(FIREBASE_PATH_FILTERED, {
        updated_at: new Date().toISOString(),
        date: dateStr || "today",
        total_rows: rows.length,
        filter_config: { project, task, date: dateStr || "today" },
        data: rows,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        mode: "filtered",
        date: dateStr || "today",
        rows,
        total: rows.length,
        project,
        task,
        updated_at: new Date().toISOString(),
      }));
      return;
    }

    // -------------------------------------------------------------
    // MODE 5: PROJECT OUTFLOW
    // -------------------------------------------------------------
    if (pathname === "/fetch-outflow" && req.method === "GET") {
      const resolved = resolveOutflowRange(query);
      if (resolved.error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: resolved.error }));
        return;
      }

      const { key, from, to, isToday } = resolved;
      let rows, updatedAt;

      if (isToday) {
        const payload = await refreshOutflow();
        rows = payload.data;
        updatedAt = payload.lastUpdated;
      } else {
        rows = await fetchOutflow(from, to);
        updatedAt = new Date().toISOString();
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        mode: "outflow",
        range: key,
        date: isToday ? "today" : (from === to ? from : `${from}..${to}`),
        from,
        to,
        rows,
        total: rows.length,
        updated_at: updatedAt,
        saved_to_firebase: isToday,
      }));
      return;
    }

    // -------------------------------------------------------------
    // MODE 7: CANCELLATION
    // -------------------------------------------------------------
    if (pathname === "/fetch-cancellation" && req.method === "GET") {
      const staffIds = parseIdsParam(query);
      const dateStr = parseDateParam(query);
      if (query.date && !dateStr) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "date must be a valid YYYY-MM-DD date" }));
        return;
      }

      const rows = await fetchCancellation(staffIds, dateStr);
      const payload = {
        updated_at: new Date().toISOString(),
        filter_config: { staff_ids: staffIds, date: dateStr || "all" },
        total_rows: rows.length,
        data: rows,
      };
      await saveCancellationToFirebase(payload);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, mode: "cancellation", ...payload }));
      return;
    }

    if (pathname === "/cancellation-columns" && req.method === "GET") {
      const rows = await runBigQuery({
        query: `#standardSQL
          SELECT column_name, data_type
          FROM \`trax-retail.backoffice.INFORMATION_SCHEMA.COLUMNS\`
          WHERE table_name = 'qat_cancelation_data'
          ORDER BY ordinal_position`,
        useLegacySql: false,
      }, 10);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        staff_column: CANCEL_STAFF_COLUMN,
        date_column: CANCEL_DATE_COLUMN,
        columns: rows
      }));
      return;
    }

    // -------------------------------------------------------------
    // MODE 6: QUEUE MONITOR
    // -------------------------------------------------------------
    if (pathname === "/queue-monitor/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        mode: "queue-monitor",
        ...queueState,
        config: {
          interval_sec: QUEUE_INTERVAL_SEC,
          concurrency: QUEUE_CONCURRENCY,
          heartbeat_sec: QUEUE_HEARTBEAT_SEC,
          projects_cache_sec: QUEUE_PROJECTS_CACHE_SEC,
          projects_source: SERVER_PROJECTS_URL,
          destination: QUEUE_FIREBASE_URL
        },
        projects: queueProjectsCache.list,
        project_count: queueProjectsCache.list.length
      }));
      return;
    }

    if (pathname === "/queue-monitor/refresh" && req.method === "GET") {
      if (queueState.running) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "A queue monitor cycle is already running" }));
        return;
      }
      await getQueueProjects(true);
      const summary = await runQueueCycle();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        mode: "queue-monitor",
        ...summary,
        updated_at: new Date().toISOString()
      }));
      return;
    }

    // Planning UI
    if (pathname === "/planning-ui" && req.method === "GET") {
      fs.readFile(PLANNING_HTML_PATH, "utf8", (err, html) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "planning.html not found next to server.js: " + err.message }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      });
      return;
    }

    // -------------------------------------------------------------
    // MODE 4: PLANNING
    // -------------------------------------------------------------
    if (pathname === "/planning" && req.method === "GET") {
      const planningMap = (await getFromFirebase(FIREBASE_PATH_PLANNING)) || {};
      const list = Object.entries(planningMap).map(([id, entry]) => ({ id, ...entry }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: list, count: list.length }));
      return;
    }

    if (pathname === "/planning" && req.method === "POST") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      const project_name = String(body.project_name || "").trim();
      const task_name = String(body.task_name || "").trim();
      const target = Number(body.target);

      if (!project_name || !task_name || !Number.isFinite(target) || target < 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "project_name, task_name, target (>= 0) required" }));
        return;
      }

      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const entry = {
        project_name,
        task_name,
        target,
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
      const updated = await refreshAllPlanning(dateStr);
      const list = Object.entries(updated).map(([id, entry]) => ({ id, ...entry }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        date: dateStr || "today",
        data: list,
        count: list.length,
        updated_at: new Date().toISOString(),
      }));
      return;
    }

    // Staff lookup
    if (pathname === "/staff-lookup" && req.method === "GET") {
      const csv = await fetchStaffLookup();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ csv }));
      return;
    }

    // Project/Task lookup
    if (pathname === "/project-task-lookup" && req.method === "GET") {
      try {
        const data = await fetchProjectTaskLookup();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, data, count: data.length }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // Denominator lookup
    if (pathname === "/denominator-lookup" && req.method === "GET") {
      try {
        const data = await getDenominatorData(true);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          data,
          count: {
            byProjectTask: Object.keys(data.byProjectTask).length,
            byGID: Object.keys(data.byGID).length,
            uf: Object.keys(data.uf || {}).length
          }
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // Default staff/TL id list
    if ((pathname === "/team-leaders" || pathname === "/staff-ids") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        staff_ids: TEAM_LEADERS,
        team_leaders: TEAM_LEADERS,
        count: TEAM_LEADERS.length
      }));
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (error) {
    console.error("❌ Server Error:", error.message);
    console.error("  Stack:", error.stack);       // stack stays in the server log, never sent to the client
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

// Start server
server.listen(PORT, HOST, () => {
  console.log("================================");
  console.log(`  🚀 QAT Server (Unified) running on http://${HOST}:${PORT}`);
  console.log(`  🔐 Basic Auth user: ${AUTH_USER}`);
  console.log(`  🌐 CORS: Enabled for all origins`);
  console.log(`  🔥 Firebase paths:`);
  console.log(`     TL mode      -> ${FIREBASE_PATH_TL}  (team_leaders/<TL_ID>/{staff_ids,rows})`);
  console.log(`     Staff mode   -> ${FIREBASE_PATH_STAFF}`);
  console.log(`     Filtered     -> ${FIREBASE_PATH_FILTERED}`);
  console.log(`     Planning     -> ${FIREBASE_PATH_PLANNING}`);
  console.log(`     Outflow      -> ${FIREBASE_OUTFLOW_URL} (today only)`);
  console.log(`     Queue        -> ${QUEUE_FIREBASE_URL}`);
  console.log(`     Queue source -> ${SERVER_PROJECTS_URL}`);
  console.log(`     Cancellation -> ${CANCELLATION_FIREBASE_URL}`);
  console.log(`  🆔 TL Hourly: roster (staff sheet) staff IDs walin query wenawa`);
  console.log(`  📊 Endpoints (most accept optional &date=YYYY-MM-DD):`);
  console.log(`    GET  /                                  - Health check`);
  console.log(`    GET  /fetch-all?shift_sup=&team_leader= - TL Hourly (roster staff IDs) -> ${FIREBASE_PATH_TL}`);
  console.log(`    GET  /fetch-all?mode=staff&staff_ids=A,B - Fetch given staff_ids -> ${FIREBASE_PATH_STAFF}`);
  console.log(`    GET  /fetch?tl_name=                    - Single TL fetch (roster first) -> ${FIREBASE_PATH_TL}`);
  console.log(`    GET  /fetch?staff_id=                   - Single staff fetch -> ${FIREBASE_PATH_STAFF}`);
  console.log(`    GET  /fetch-filtered?project=&task=     - Project+Task filtered -> ${FIREBASE_PATH_FILTERED}`);
  console.log(`    GET  /fetch-outflow                     - Project outflow (today) -> project-gap.json`);
  console.log(`    GET  /fetch-outflow?range=yesterday|day_before|last_week   - past preset (not saved)`);
  console.log(`    GET  /fetch-outflow?from=YYYY-MM-DD&to=YYYY-MM-DD          - custom range (not saved)`);
  console.log(`    GET  /fetch-cancellation?staff_ids=A,B&date= - Cancellation data -> qat_cancelation_data`);
  console.log(`    GET  /cancellation-columns              - Cancellation table columns`);
  console.log(`    GET  /queue-monitor/status              - Queue monitor status`);
  console.log(`    GET  /queue-monitor/refresh             - Run one queue monitor cycle now`);
  console.log(`    GET  /monitor                           - Trax Team Monitor dashboard`);
  console.log(`    GET  /monitor/project/<name>            - Trax locked tasks for one project (live)`);
  console.log(`    GET  /planning-ui                       - Planning Tracker page (no login needed to load it)`);
  console.log(`    GET  /planning                          - List planning entries`);
  console.log(`    POST /planning                          - Add {project_name,task_name,target}`);
  console.log(`    DEL  /planning?id=                      - Remove a planning entry`);
  console.log(`    GET  /planning-fetch                    - Refresh actual/% for all -> ${FIREBASE_PATH_PLANNING}`);
  console.log(`    GET  /staff-lookup                      - Staff name lookup`);
  console.log(`    GET  /project-task-lookup               - Project/Task lookup`);
  console.log(`    GET  /denominator-lookup                - Denominator lookup`);
  console.log(`    GET  /team-leaders | /staff-ids         - Default ID list`);
  console.log("================================");

  startOutflowAutoLoop();
  startQueueAutoLoop();
  startTraxMonitor();
});

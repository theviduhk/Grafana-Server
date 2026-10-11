const axios = require("axios");
const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
| Modes:
|   1. Team Leader fetch        -> /TL Hourly.json
|   2. Staff ID fetch           -> /QAT2 Output.json
|   3. Project + Task filtered  -> /qat_filtered.json
|   4. Planning                 -> /planning.json
|   5. Project Outflow          -> projectgap Firebase
|   6. Queue Monitor            -> thevindu Firebase
|   7. QAT Cancellations        -> cancellation-7294a Firebase
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

// MODE 7
const CANCELLATION_FIREBASE_BASE =
  process.env.CANCELLATION_FIREBASE_BASE ||
  "https://cancellation-7294a-default-rtdb.firebaseio.com";

const CANCELLATION_TODAY_URL = `${CANCELLATION_FIREBASE_BASE}/cancellations.json`;

const CANCELLATION_ARCHIVE_URL = (dateStr) =>
  `${CANCELLATION_FIREBASE_BASE}/cancellations-by-date/${dateStr}.json`;

const CANCELLATION_AUTO_INTERVAL_SEC = Number(
  process.env.CANCELLATION_INTERVAL_SEC ?? 60
);

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
| MODE 7 CONFIG - QAT CANCELLATIONS
|--------------------------------------------------------------------------
| ⚠️ IMPORTANT: Verify these against your real BigQuery schema.
| Use /debug-tables endpoint to find the actual table name and columns.
|--------------------------------------------------------------------------
*/
const CANCELLATION_TABLE =
  process.env.CANCELLATION_TABLE ||
  "trax-retail.backoffice.qat_cancellations";

const CANCELLATION_COL = {
  user:      process.env.CANCELLATION_COL_USER      || "user",
  empName:   process.env.CANCELLATION_COL_EMP_NAME  || "employee_name",
  project:   process.env.CANCELLATION_COL_PROJECT   || "project_name",
  task:      process.env.CANCELLATION_COL_TASK      || "task_name",
  probe:     process.env.CANCELLATION_COL_PROBE     || "probe_scene",
  reason:    process.env.CANCELLATION_COL_REASON    || "cancel_reason",
  timestamp: process.env.CANCELLATION_COL_TIMESTAMP || "event_timestamp",
};

const CANCELLATION_TZ_OFFSET_MIN = 330; // Asia/Colombo = UTC+05:30

const PLANNING_HTML_PATH = path.join(__dirname, "planning.html");
const CANCELLATIONS_HTML_PATH = path.join(__dirname, "cancellations.html");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const TEAM_LEADERS = [
  "G26658-OTL",
  "G25883-OTL",
  "G22371-OTL",
  "G23179-OTL"
];

const STAFF_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=1860286382&output=csv";

const PROJECT_TASK_SHEET_URL = () =>
  `https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=822634964&output=csv&_=${Date.now()}`;

const AUTH_USER = process.env.AUTH_USER || "admin";
const AUTH_PASS = process.env.AUTH_PASS || "password123";
const GRAFANA_USER = process.env.GRAFANA_USER || "gss.kurunegala@gssintl.biz";
const GRAFANA_PASS = process.env.GRAFANA_PASS || "Gssk@2021";

/*
|--------------------------------------------------------------------------
| CORS HEADERS
|--------------------------------------------------------------------------
*/
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Accept",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Max-Age": "86400"
};

function setCorsHeaders(res) {
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
}

function authenticate(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;
  try {
    const base64 = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64, 'base64').toString('utf8');
    const [user, pass] = credentials.split(':');
    return user === AUTH_USER && pass === AUTH_PASS;
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

function todayColombo() {
  const now = new Date();
  const colombo = new Date(now.getTime() + CANCELLATION_TZ_OFFSET_MIN * 60 * 1000);
  return colombo.toISOString().slice(0, 10);
}

function buildDateRangeClause(dateStr) {
  if (dateStr) {
    return `event_timestamp BETWEEN TIMESTAMP('${dateStr} 00:00:00') AND TIMESTAMP('${dateStr} 23:59:59.999999')`;
  }
  return `event_timestamp BETWEEN TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY) AND CURRENT_TIMESTAMP()`;
}

/*
|--------------------------------------------------------------------------
| SQL HELPERS
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
| GRAFANA SESSION MANAGER
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
| BUILD SQL
|--------------------------------------------------------------------------
*/
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

/*
|--------------------------------------------------------------------------
| MODE 7: BUILD CANCELLATIONS SQL
|--------------------------------------------------------------------------
*/
function buildQueryCancellations(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const colomboStartMs = Date.UTC(y, m - 1, d, 0, 0, 0);
  const utcStartMs = colomboStartMs - CANCELLATION_TZ_OFFSET_MIN * 60 * 1000;
  const utcEndMs = utcStartMs + 24 * 60 * 60 * 1000;

  const toIsoUtc = (ms) =>
    new Date(ms).toISOString().replace("T", " ").slice(0, 19);

  const startIso = toIsoUtc(utcStartMs);
  const endIso = toIsoUtc(utcEndMs);

  const C = CANCELLATION_COL;

  return {
    query: `
      #standardSQL
      SELECT
        ${C.user}      AS user,
        ${C.empName}   AS employee_name,
        ${C.project}   AS project_name,
        ${C.task}      AS task_name,
        ${C.probe}     AS probe_scene,
        ${C.reason}    AS cancel_reason,
        UNIX_MILLIS(${C.timestamp}) AS timestamp
      FROM \`${CANCELLATION_TABLE}\`
      WHERE ${C.timestamp} >= TIMESTAMP('${startIso}')
        AND ${C.timestamp} <  TIMESTAMP('${endIso}')
        AND ${C.reason} IS NOT NULL
        AND TRIM(${C.reason}) != ''
      ORDER BY ${C.timestamp} DESC
      LIMIT 10000
    `,
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

function processCancellationResults(result) {
  if (!result.rows) return [];
  const fields = result.schema.fields.map(f => f.name);
  return result.rows.map(row => {
    const obj = {};
    row.f.forEach((cell, i) => { obj[fields[i]] = cell.v; });
    return {
      user:          String(obj.user || "").trim(),
      employee_name: String(obj.employee_name || "").trim(),
      project_name:  String(obj.project_name || "").trim(),
      task_name:     String(obj.task_name || "").trim(),
      probe_scene:   String(obj.probe_scene || "").trim(),
      cancel_reason: String(obj.cancel_reason || "").trim(),
      timestamp:     Number(obj.timestamp || 0),
    };
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
  console.log("  🔥 Outflow Firebase updated");
}

async function saveCancellationsTodayToFirebase(payload) {
  await axios.put(CANCELLATION_TODAY_URL, payload, { timeout: 30000 });
  console.log(`  🔥 Cancellations saved to /cancellations.json (date=${payload.date})`);
}

async function saveCancellationsDateToFirebase(dateStr, payload) {
  await axios.put(CANCELLATION_ARCHIVE_URL(dateStr), payload, { timeout: 30000 });
  console.log(`  🔥 Cancellations archived to /cancellations-by-date/${dateStr}.json`);
}

/*
|--------------------------------------------------------------------------
| DENOMINATOR LOOKUP
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
| FETCH — MODE 1: Team Leader
|--------------------------------------------------------------------------
*/
async function fetchSingleTL(tlName, dateStr) {
  console.log(`  [TL] Fetching: tl_name="${tlName}" date="${dateStr || 'today'}"`);
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

async function fetchAllTeamLeaders(list, dateStr) {
  const tlList = (list && list.length) ? list : TEAM_LEADERS;
  console.log(`\n>>> [TL] Fetching data for ${tlList.length} Team Leaders... date="${dateStr || 'today'}"`);
  const results = await Promise.all(
    tlList.map(async (tlName) => {
      try {
        return await fetchSingleTL(tlName, dateStr);
      } catch (err) {
        console.error(`  Error fetching ${tlName}:`, err.message);
        return { tl_name: tlName, error: err.message, rows: [], total_rows: 0, fetched_at: new Date().toISOString() };
      }
    })
  );
  return results;
}

/*
|--------------------------------------------------------------------------
| FETCH — MODE 2: Staff ID
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
  if (outflowRunning) return;
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
    console.log("  ⏸️ [OUTFLOW] Auto refresh disabled");
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
| FETCH — MODE 7: QAT CANCELLATIONS
|--------------------------------------------------------------------------
*/
async function fetchCancellations(dateStr) {
  console.log(`\n>>> [CANCELLATIONS] Fetching cancellations... date="${dateStr}"`);
  const query = buildQueryCancellations(dateStr);
  const response = await grafanaRequest('POST', QUERY_URL, query);
  const jobId = response.data.jobReference.jobId;
  const location = response.data.jobReference.location;
  const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;

  let result = await getQueryResults(resultUrl, 15);
  let rows = processCancellationResults(result);

  let pageToken = result.pageToken;
  let pages = 1;
  while (pageToken && pages < 20) {
    const pageRes = await grafanaRequest(
      'GET',
      `${resultUrl}&pageToken=${encodeURIComponent(pageToken)}`
    );
    result = pageRes.data;
    rows = rows.concat(processCancellationResults(result));
    pageToken = result.pageToken;
    pages++;
  }

  console.log(`  Rows found: ${rows.length}`);
  return rows;
}

let cancellationRunning = false;

async function refreshCancellations() {
  const dateStr = todayColombo();
  const rows = await fetchCancellations(dateStr);

  const payload = {
    lastUpdated: new Date().toISOString(),
    date: dateStr,
    timezone: "Asia/Colombo",
    total_rows: rows.length,
    data: rows,
  };

  await saveCancellationsTodayToFirebase(payload);
  await saveCancellationsDateToFirebase(dateStr, payload);

  return payload;
}

async function refreshCancellationsForDate(dateStr) {
  const rows = await fetchCancellations(dateStr);
  const payload = {
    lastUpdated: new Date().toISOString(),
    date: dateStr,
    timezone: "Asia/Colombo",
    total_rows: rows.length,
    data: rows,
  };

  await saveCancellationsDateToFirebase(dateStr, payload);

  if (dateStr === todayColombo()) {
    await saveCancellationsTodayToFirebase(payload);
  }

  return payload;
}

async function autoRefreshCancellationsOnce() {
  if (cancellationRunning) return;
  cancellationRunning = true;
  try {
    await refreshCancellations();
    console.log("✅ [CANCELLATIONS] Updated:", new Date().toLocaleTimeString());
  } catch (err) {
    console.error("❌ [CANCELLATIONS] Auto refresh error:", err.message);
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
      console.log("  ⚠️ [QUEUE] No projects found");
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
    console.log("  ⏸️ [QUEUE] Auto refresh disabled");
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
| STAFF / PROJECT-TASK LOOKUP
|--------------------------------------------------------------------------
*/
async function fetchStaffLookup() {
  try {
    const response = await axios.get(STAFF_SHEET_URL, { responseType: 'text' });
    return response.data;
  } catch (err) {
    console.error('Staff lookup error:', err.message);
    throw new Error('Failed to fetch staff sheet: ' + err.message);
  }
}

async function fetchProjectTaskLookup() {
  try {
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

    return records;
  } catch (err) {
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
| HTTP SERVER
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

  const AUTH_EXEMPT_PATHS = ["/fetch-filtered", "/planning-ui", "/cancellations-ui"];
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
    // Health check
    if (pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        service: "QAT Server - Unified",
        time: new Date().toISOString(),
        cors: "enabled",
        outflow_auto_interval_sec: OUTFLOW_AUTO_INTERVAL_SEC,
        queue_auto_interval_sec: QUEUE_INTERVAL_SEC,
        cancellation_auto_interval_sec: CANCELLATION_AUTO_INTERVAL_SEC,
        cancellation_firebase: CANCELLATION_FIREBASE_BASE,
        cancellation_table: CANCELLATION_TABLE,
      }));
      return;
    }

    // -------------------------------------------------------------
    // DEBUG: list all BigQuery tables matching "cancel" in the name
    //   /debug-tables
    // -------------------------------------------------------------
    if (pathname === "/debug-tables" && req.method === "GET") {
      const queries = {
        tablesBackoffice: `
          SELECT table_name
          FROM \`trax-retail.backoffice.INFORMATION_SCHEMA.TABLES\`
          WHERE LOWER(table_name) LIKE '%cancel%'
          ORDER BY table_name
        `,
        tablesAllDatasets: `
          SELECT table_schema, table_name
          FROM \`trax-retail.INFORMATION_SCHEMA.TABLES\`
          WHERE LOWER(table_name) LIKE '%cancel%'
          ORDER BY table_schema, table_name
        `,
        columnsBackoffice: `
          SELECT table_name, column_name, data_type, ordinal_position
          FROM \`trax-retail.backoffice.INFORMATION_SCHEMA.COLUMNS\`
          WHERE LOWER(table_name) LIKE '%cancel%'
          ORDER BY table_name, ordinal_position
        `,
        columnsAllDatasets: `
          SELECT table_schema, table_name, column_name, data_type, ordinal_position
          FROM \`trax-retail.INFORMATION_SCHEMA.COLUMNS\`
          WHERE LOWER(table_name) LIKE '%cancel%'
          ORDER BY table_schema, table_name, ordinal_position
        `,
      };

      const out = {};
      for (const [key, sql] of Object.entries(queries)) {
        try {
          const response = await grafanaRequest('POST', QUERY_URL, {
            query: `#standardSQL\n${sql}`,
            useLegacySql: false,
          });
          const jobId = response.data.jobReference.jobId;
          const location = response.data.jobReference.location;
          const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;
          const result = await getQueryResults(resultUrl, 15);
          const fields = (result.schema && result.schema.fields || []).map(f => f.name);
          out[key] = (result.rows || []).map(row => {
            const o = {};
            row.f.forEach((c, i) => { o[fields[i]] = c.v; });
            return o;
          });
        } catch (e) {
          out[key] = {
            error: e.message,
            status: e.response && e.response.status,
            data: e.response && e.response.data,
          };
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, result: out }, null, 2));
      return;
    }

    // DEBUG: test a single cancellation query for a date
    if (pathname === "/debug-cancellations" && req.method === "GET") {
      const dateStr = parseDateParam(query) || todayColombo();
      const q = buildQueryCancellations(dateStr);
      let bigqueryError = null;
      let rowCount = null;
      let sampleRows = [];
      try {
        const response = await grafanaRequest('POST', QUERY_URL, q);
        const jobId = response.data.jobReference.jobId;
        const location = response.data.jobReference.location;
        const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;
        const result = await getQueryResults(resultUrl, 15);
        rowCount = (result.rows || []).length;
        sampleRows = processCancellationResults(result).slice(0, 3);
      } catch (e) {
        bigqueryError = {
          message: e.message,
          status: e.response && e.response.status,
          data: e.response && e.response.data,
        };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: !bigqueryError,
        date: dateStr,
        table: CANCELLATION_TABLE,
        columns: CANCELLATION_COL,
        sql: q.query,
        rowCount,
        sampleRows,
        bigqueryError,
      }, null, 2));
      return;
    }

    // MODE 1: TEAM LEADER
    if (pathname === "/fetch-all" && req.method === "GET" && (!query.mode || query.mode === "tl")) {
      const requestedIds = parseIdsParam(query);
      const dateStr = parseDateParam(query);
      const allData = await fetchAllTeamLeaders(requestedIds, dateStr);
      await saveToFirebase(FIREBASE_PATH_TL, {
        updated_at: new Date().toISOString(),
        date: dateStr || "today",
        total_leaders: allData.length,
        data: allData
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true, mode: "tl", date: dateStr || "today",
        data: allData, total_leaders: allData.length,
        updated_at: new Date().toISOString()
      }));
      return;
    }

    // MODE 2: STAFF ID
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
        success: true, mode: "staff", date: dateStr || "today",
        data: allData, total_leaders: allData.length,
        staff_ids: requestedIds.length ? requestedIds : TEAM_LEADERS,
        updated_at: new Date().toISOString()
      }));
      return;
    }

    // Single fetch
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
          success: true, mode: "staff", date: dateStr || "today",
          rows: data.rows, total: data.total_rows, staff_id: staffId,
          updated_at: new Date().toISOString(),
        }));
        return;
      }

      const tlName = String(query.tl_name || TEAM_LEADERS[0]).trim();
      const data = await fetchSingleTL(tlName, dateStr);
      await saveToFirebase(FIREBASE_PATH_TL, {
        updated_at: new Date().toISOString(),
        date: dateStr || "today",
        total_rows: data.total_rows,
        filter_config: { tl_name: tlName, date: dateStr || "today" },
        data: data.rows,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true, mode: "tl", date: dateStr || "today",
        rows: data.rows, total: data.total_rows, tl_name: tlName,
        updated_at: new Date().toISOString(),
      }));
      return;
    }

    // MODE 3: FILTERED
    if (pathname === "/fetch-filtered" && req.method === "GET") {
      const project = (query.project || "").trim();
      const task = (query.task || "").trim();
      const dateStr = parseDateParam(query);

      if (!project || !task) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "project සහ task දෙකම required" }));
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
        success: true, mode: "filtered", date: dateStr || "today",
        rows, total: rows.length, project, task,
        updated_at: new Date().toISOString(),
      }));
      return;
    }

    // MODE 5: OUTFLOW
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
        success: true, mode: "outflow", range: key,
        date: isToday ? "today" : (from === to ? from : `${from}..${to}`),
        from, to, rows, total: rows.length, updated_at: updatedAt,
        saved_to_firebase: isToday,
      }));
      return;
    }

    // MODE 7: CANCELLATIONS
    if (pathname === "/fetch-cancellations" && req.method === "GET") {
      const requested = parseDateParam(query);
      const targetDate = requested || todayColombo();

      if (targetDate > todayColombo()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Cannot fetch future dates" }));
        return;
      }

      const payload =
        targetDate === todayColombo()
          ? await refreshCancellations()
          : await refreshCancellationsForDate(targetDate);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true, mode: "cancellations",
        date: payload.date, timezone: payload.timezone,
        rows: payload.data, total: payload.total_rows,
        updated_at: payload.lastUpdated,
        saved_to_firebase: true,
        is_today: targetDate === todayColombo(),
      }));
      return;
    }

    // Read cancellations from Firebase
    if (pathname === "/cancellations" && req.method === "GET") {
      const requested = parseDateParam(query);
      const targetDate = requested || todayColombo();
      const readUrl =
        targetDate === todayColombo()
          ? CANCELLATION_TODAY_URL
          : CANCELLATION_ARCHIVE_URL(targetDate);

      try {
        const r = await axios.get(readUrl, { timeout: 30000 });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true, mode: "cancellations-read",
          date: targetDate, source: readUrl, payload: r.data || null,
        }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true, mode: "cancellations-read",
          date: targetDate, source: readUrl, payload: null,
          note: "No data at that node yet",
        }));
      }
      return;
    }

    // MODE 6: QUEUE MONITOR
    if (pathname === "/queue-monitor/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true, mode: "queue-monitor",
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
        success: true, mode: "queue-monitor", ...summary,
        updated_at: new Date().toISOString()
      }));
      return;
    }

    // Planning UI
    if (pathname === "/planning-ui" && req.method === "GET") {
      fs.readFile(PLANNING_HTML_PATH, "utf8", (err, html) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "planning.html not found: " + err.message }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      });
      return;
    }

    // Cancellations UI
    if (pathname === "/cancellations-ui" && req.method === "GET") {
      fs.readFile(CANCELLATIONS_HTML_PATH, "utf8", (err, html) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "cancellations.html not found: " + err.message }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      });
      return;
    }

    // MODE 4: PLANNING
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
        project_name, task_name, target,
        actual: 0, percentage: 0,
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
        success: true, date: dateStr || "today",
        data: list, count: list.length,
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
          success: true, data,
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

    // Default ID list
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
    console.error("  Stack:", error.stack);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: error.message,
      details: error.stack
    }));
  }
});

// Start server
server.listen(PORT, HOST, () => {
  console.log("================================");
  console.log(`  🚀 QAT Server (Unified) running on http://${HOST}:${PORT}`);
  console.log(`  🔐 Basic Auth user: ${AUTH_USER}`);
  console.log(`  🌐 CORS: Enabled for all origins`);
  console.log(`  🔥 Firebase paths:`);
  console.log(`     TL mode         -> ${FIREBASE_PATH_TL}`);
  console.log(`     Staff mode      -> ${FIREBASE_PATH_STAFF}`);
  console.log(`     Filtered        -> ${FIREBASE_PATH_FILTERED}`);
  console.log(`     Planning        -> ${FIREBASE_PATH_PLANNING}`);
  console.log(`     Outflow         -> ${FIREBASE_OUTFLOW_URL} (today only)`);
  console.log(`     Queue           -> ${QUEUE_FIREBASE_URL}`);
  console.log(`     Queue source    -> ${SERVER_PROJECTS_URL}`);
  console.log(`     Cancellations   -> ${CANCELLATION_TODAY_URL}`);
  console.log(`     Cancellations*  -> ${CANCELLATION_FIREBASE_BASE}/cancellations-by-date/<date>.json`);
  console.log(`  📊 Cancel table: ${CANCELLATION_TABLE}`);
  console.log("================================");

  startOutflowAutoLoop();
  startQueueAutoLoop();
  startCancellationsAutoLoop();
});

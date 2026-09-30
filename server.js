const axios = require("axios");
const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
| Meka thani server ekakin thanku data 5ma type eka handle karanawa:
|   1. Team Leader (team_leader_staff_id) fetch  -> /TL Hourly.json
|   2. Staff ID (staff_id) fetch                 -> /QAT2 Output.json
|   3. Project + Task filtered fetch             -> /qat_filtered.json
|   4. Planning (project + task + target, multi) -> /planning.json
|   5. Project Outflow (project | task | center) -> projectgap Firebase
|                                                   Firebase /project-gap.json
|
| Modes 1-4 support optional `date=YYYY-MM-DD`. Date eka denne nathnam
| (allathwa waradi format eka dunnoth) default eka widihata "today" query
| eka run wenawa.
|
| MODE 5 (/fetch-outflow) supports more:
|   (none)                                   -> today   (also saved to Firebase)
|   ?date=YYYY-MM-DD                         -> that single day
|   ?range=today|yesterday|day_before|last_week
|   ?from=YYYY-MM-DD&to=YYYY-MM-DD           -> custom range (max 92 days)
| Only "today" is written to Firebase (project-gap.json). Past dates / ranges
| are returned to the caller only, so they can never overwrite today's data.
|--------------------------------------------------------------------------
*/
const QUERY_URL =
  "https://monitor-public.trax-cloud.com/api/datasources/proxy/133/bigquery/v2/projects/trax-ortal-prod/queries";

const FIREBASE_URL = "https://qat-output-default-rtdb.firebaseio.com";

// Wenama Firebase path - features anuwa
const FIREBASE_PATH_TL       = "/TL Hourly.json";     // Team Leader mode
const FIREBASE_PATH_STAFF    = "/QAT2 Output.json";   // Staff ID mode
const FIREBASE_PATH_FILTERED = "/qat_filtered.json";  // Project/Task filtered mode
const FIREBASE_PATH_PLANNING = "/planning.json";      // Planning mode

// MODE 5 (Outflow) - wenama Firebase database ekak, e nisa full URL eka.
const FIREBASE_OUTFLOW_URL =
  "https://projectgap-4b7d9-default-rtdb.firebaseio.com/project-gap.json";

// Outflow data eka background eken auto-refresh wena gaman (seconds).
// Kalin script eke wage 10s. 0 dunnoth auto-refresh nawathinawa (manual
// /fetch-outflow call witharak). Render env eken OUTFLOW_INTERVAL_SEC
// widihata change karanna puluwan.
const OUTFLOW_AUTO_INTERVAL_SEC = Number(process.env.OUTFLOW_INTERVAL_SEC ?? 10);

// Longest custom range /fetch-outflow will accept (days, inclusive).
const OUTFLOW_MAX_RANGE_DAYS = Number(process.env.OUTFLOW_MAX_RANGE_DAYS ?? 92);

// What "Previous Week" (range=last_week) means:
//   "calendar" -> the last full Monday-Sunday week (default)
//   "rolling"  -> the 7 days ending yesterday
const PREVIOUS_WEEK_MODE = (process.env.PREVIOUS_WEEK_MODE || "calendar").toLowerCase();

// planning.html eka mema server.js eka thiyena FOLDER ekamama thiyanna oni
const PLANNING_HTML_PATH = path.join(__dirname, "planning.html");

// Render port config (Render PORT env eken automatic set wenawa)
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// Default Team Leader / Staff IDs list
const TEAM_LEADERS = [
  "G26658-OTL",
  "G25883-OTL",
  "G22371-OTL",
  "G23179-OTL"
];

// Staff lookup sheet
const STAFF_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=1860286382&output=csv";

// Project/Task lookup sheet (denominator matrix source)
const PROJECT_TASK_SHEET_URL = () =>
  `https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=822634964&output=csv&_=${Date.now()}`;

/*
|--------------------------------------------------------------------------
| CREDENTIALS
|--------------------------------------------------------------------------
| Env variables set karala thiyenawanam ewa use wenawa, nathnam kalin
| thibba default values. Render dashboard eke Environment walata danna:
|   AUTH_USER, AUTH_PASS, GRAFANA_USER, GRAFANA_PASS
|--------------------------------------------------------------------------
*/
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

// Returns the same string if it is a real calendar date in YYYY-MM-DD form, else null.
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
| OUTFLOW DATE RANGE RESOLVER
|--------------------------------------------------------------------------
| All calendar maths is done in UTC, the same day boundary BigQuery's
| CURRENT_DATE() uses for "today", so presets and today stay consistent.
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

// -> { key, from, to, isToday }  or  { error }
function resolveOutflowRange(query) {
  const today = todayUTC();
  const todayStr = ymdUTC(today);
  const range = query.range ? String(query.range).trim().toLowerCase() : "";
  const fromRaw = query.from ? String(query.from).trim() : "";
  const toRaw = query.to ? String(query.to).trim() : "";

  let key, from, to;

  if (fromRaw || toRaw) {
    // Custom range: both ends required and valid
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
        const sinceMonday = (today.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
        const thisMonday = addDaysUTC(today, -sinceMonday);
        from = ymdUTC(addDaysUTC(thisMonday, -7));
        to = ymdUTC(addDaysUTC(thisMonday, -1));
      }
    } else {
      return { error: "range must be one of: today, yesterday, day_before, last_week" };
    }
  } else if (query.date) {
    // Backwards compatible single-day param
    const d = parseDateParam(query);
    if (!d) return { error: "date must be a valid YYYY-MM-DD date" };
    key = "date";
    from = to = d;
  } else {
    key = "today";
    from = to = todayStr;
  }

  if (from > todayStr) return { error: "The selected dates are in the future" };
  if (to > todayStr) to = todayStr; // ranges can't run past today

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
| maxTries * 2s = max wait. Default 10 (20s). Range queries pass a bigger number.
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
| BUILD SQL — variants (team leader / staff id / project+task / outflow)
|--------------------------------------------------------------------------
*/
function buildQueryByTeamLeader(tlName, dateStr) {
  const safeTl = String(tlName).replace(/'/g, "\\'");
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
        AND team_leader_staff_id = '${safeTl}'
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY timestamp
    `,
    useLegacySql: false,
  };
}

function buildQueryByStaffId(staffId, dateStr) {
  const safeStaffId = String(staffId).replace(/'/g, "\\'");
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
        AND staff_id = '${safeStaffId}'
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY timestamp
    `,
    useLegacySql: false,
  };
}

function buildQueryByProjectTask(project, task, dateStr) {
  const safeProject = String(project).replace(/'/g, "\\'");
  const safeTask = String(task).replace(/'/g, "\\'");
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

// MODE 5: Project outflow (kalin standalone script eke query eka).
// Kalin "CONCAT(project_name,' | ',task_name,' | ',center)" karala pasuwa
// split karanawa wenuwata, dan columns 3ma wenama select karanawa - e nisa
// project name ekaka " | " thibunath data waradi wenne na.
//
// fromStr / toStr = 'YYYY-MM-DD' (already validated by resolveOutflowRange, so safe to inline).
// Both null -> today via CURRENT_DATE(). Output shape is identical for a day or a range:
// values are summed per project / task / center over the whole range.
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

// MODE 5 rows: { project, task, center, value }  (kalin script eke output shape eka)
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

// MODE 5 - wenama Firebase database ekata (project-gap.json) save karanawa
async function saveOutflowToFirebase(payload) {
  await axios.put(FIREBASE_OUTFLOW_URL, payload, { timeout: 30000 });
  console.log("  🔥 Outflow Firebase updated (project-gap.json)");
}

/*
|--------------------------------------------------------------------------
| DENOMINATOR LOOKUP (normalized keys - lowercase + trimmed)
|--------------------------------------------------------------------------
| The published "Denominator Sheet" CSV (gid 822634964) actually contains
| TWO independent tables side by side:
|
|   Table 1 "Denominator Sheet"  -> columns A:Y  (Project + task-name grid)
|   Table 2 "UF Denominator"     -> columns AA:AD (Project, Task, Sub Task, Denominator)
|
| They are NOT row-aligned. Row 1 of the CSV is a merged title row - the
| REAL column headers are on row 2, and data starts on row 3.
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

// Fixed column offsets of the UF Denominator table (columns AA:AD).
const UF_COL_PROJECT = 26;
const UF_COL_TASK = 27;
const UF_COL_SUBTASK = 28;
const UF_COL_DENOMINATOR = 29;

let denominatorCache = {
  data: null,
  timestamp: null,
  cacheDuration: 5 * 60 * 1000 // 5 minutes
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

      // ---- Table 1: "Denominator Sheet" (project x task grid) ----
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

      // ---- Table 2: "UF Denominator" (independent long-format table) ----
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
| TASK FALLBACK GROUPS (sheet eke cell eka empty/"-" unoth)
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

// 1. exact task, subtask = Menu
// 2. exact task, any other subtask
// 3. equivalent task, subtask = Menu
// 4. equivalent task, any other subtask
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

  // PGES: "Repair Only" when template_name contains "display", else "Repair & Attribute".
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

  // Fallback: main "Denominator Sheet" matrix, then the hardcoded fallback.
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
| FETCH — MODE 1: Team Leader (team_leader_staff_id)
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
| FETCH — MODE 4: Planning (multiple project+task+target combos)
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
| FETCH — MODE 5: Project Outflow (project | task | center)
|--------------------------------------------------------------------------
| 560_project_outflow table eken project/task/center wise SUM(count) aran
| denawa. fromStr/toStr null nam "today" (CURRENT_DATE()); nathnam e day
| eka / range eka.
|
| Saved to Firebase (/project-gap.json) ONLY for today - see refreshOutflow().
| Saved shape (kalin ekama):
|   { lastUpdated, date, total_rows, data: [{ project, task, center, value }] }
|
| BigQuery result eka pages walata kadala enna puluwan, e nisa pageToken
| thiyenakan ma ella pages ekathu karagannawa.
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

  // Multi-day ranges scan more data, so allow the job longer to finish (30 x 2s = 60s)
  const isMultiDay = !!(fromStr && toStr && fromStr !== toStr);
  let result = await getQueryResults(resultUrl, isMultiDay ? 30 : 10);
  let rows = processOutflowResults(result);

  // Extra pages (large result sets)
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

// Overlap guard - aluth refresh ekak start wenna kalin kalin ekak iwara wela nathnam skip karanawa
let outflowRunning = false;

// TODAY only: fetch + write to Firebase (project-gap.json). Used by the auto loop and by
// /fetch-outflow when the resolved range is today.
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
    await refreshOutflow(); // auto-refresh eka hemadama "today"
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
| STAFF LOOKUP
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

  // /fetch-filtered saha /planning-ui walata Basic Auth oni na (kalin widihatama).
  // Anith okkoma endpoints (/fetch-outflow ekath ekka) Basic Auth oni.
  const AUTH_EXEMPT_PATHS = ["/fetch-filtered", "/planning-ui"];
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
        service: "QAT Server - Unified (TL / Staff ID / Project-Task / Planning / Outflow)",
        time: new Date().toISOString(),
        cors: "enabled",
        outflow_auto_interval_sec: OUTFLOW_AUTO_INTERVAL_SEC
      }));
      return;
    }

    // -------------------------------------------------------------
    // MODE 1: TEAM LEADER — /fetch-all?mode=tl&date=YYYY-MM-DD  (default mode)
    // -------------------------------------------------------------
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
        success: true,
        mode: "tl",
        date: dateStr || "today",
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
      await saveToFirebase(FIREBASE_PATH_TL, {
        updated_at: new Date().toISOString(),
        date: dateStr || "today",
        total_rows: data.total_rows,
        filter_config: { tl_name: tlName, date: dateStr || "today" },
        data: data.rows,
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
    // MODE 3: PROJECT + TASK FILTERED — /fetch-filtered?project=&task=&date=YYYY-MM-DD
    // -------------------------------------------------------------
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
    //   /fetch-outflow                                 -> today  (saved to Firebase)
    //   /fetch-outflow?range=yesterday|day_before|last_week|today
    //   /fetch-outflow?from=YYYY-MM-DD&to=YYYY-MM-DD   -> custom range
    //   /fetch-outflow?date=YYYY-MM-DD                 -> single day (legacy)
    // Only "today" is written to Firebase (project-gap.json). Past dates / ranges
    // are returned in the response only, so they never overwrite today's data.
    // Response: { success, mode, range, date, from, to, rows, total, updated_at, saved_to_firebase }
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
        const payload = await refreshOutflow(); // fetch + save to Firebase
        rows = payload.data;
        updatedAt = payload.lastUpdated;
      } else {
        rows = await fetchOutflow(from, to); // fetch only, no Firebase write
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

    // GET /planning  -> list every planning entry
    if (pathname === "/planning" && req.method === "GET") {
      const planningMap = (await getFromFirebase(FIREBASE_PATH_PLANNING)) || {};
      const list = Object.entries(planningMap).map(([id, entry]) => ({ id, ...entry }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: list, count: list.length }));
      return;
    }

    // POST /planning  -> add a new { project_name, task_name, target } entry
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

    // DELETE /planning?id=xxx  -> remove a planning entry
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

    // GET /planning-fetch?date=YYYY-MM-DD
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
        const data = await getDenominatorData(true); // force refresh
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
  console.log(`     TL mode      -> ${FIREBASE_PATH_TL}`);
  console.log(`     Staff mode   -> ${FIREBASE_PATH_STAFF}`);
  console.log(`     Filtered     -> ${FIREBASE_PATH_FILTERED}`);
  console.log(`     Planning     -> ${FIREBASE_PATH_PLANNING}`);
  console.log(`     Outflow      -> ${FIREBASE_OUTFLOW_URL} (today only)`);
  console.log(`  📊 Endpoints (most accept optional &date=YYYY-MM-DD):`);
  console.log(`    GET  /                                  - Health check`);
  console.log(`    GET  /fetch-all?mode=tl                 - Fetch all Team Leaders -> ${FIREBASE_PATH_TL}`);
  console.log(`    GET  /fetch-all?mode=staff&staff_ids=A,B - Fetch given staff_ids -> ${FIREBASE_PATH_STAFF}`);
  console.log(`    GET  /fetch?tl_name=                    - Single TL fetch -> ${FIREBASE_PATH_TL}`);
  console.log(`    GET  /fetch?staff_id=                   - Single staff fetch -> ${FIREBASE_PATH_STAFF}`);
  console.log(`    GET  /fetch-filtered?project=&task=     - Project+Task filtered -> ${FIREBASE_PATH_FILTERED}`);
  console.log(`    GET  /fetch-outflow                     - Project outflow (today) -> project-gap.json`);
  console.log(`    GET  /fetch-outflow?range=yesterday|day_before|last_week   - past preset (not saved)`);
  console.log(`    GET  /fetch-outflow?from=YYYY-MM-DD&to=YYYY-MM-DD          - custom range (not saved)`);
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

  // MODE 5 background auto-refresh (kalin standalone script eke loop eka wage)
  startOutflowAutoLoop();
});

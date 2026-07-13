const axios = require("axios");
const http = require("http");
const url = require("url");

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
| Meka 3 wena server.js codes (TL-based, staff_id-based, project+task-based)
| ekama file ekakata merge karapu eka. Ekineka logic eka (Grafana login,
| BigQuery polling, denominator lookup, CSV lookups) shared functions widihata
| use wenawa. Endpoint 4ක widihata wenas wenas features tika access karanna
| puluwan, saha ekineka Firebase path ekatama save wenawa.
|--------------------------------------------------------------------------
*/
const QUERY_URL =
  "https://monitor-public.trax-cloud.com/api/datasources/proxy/133/bigquery/v2/projects/trax-ortal-prod/queries";

const FIREBASE_URL = "https://qat-output-default-rtdb.firebaseio.com";

// Wenas wenas features walata wenas wenas Firebase paths (original 3 codes wලම tibuna widihatama)
const FIREBASE_PATH_TL = "/TL Hourly.json";           // file 1 -> tl_name based
const FIREBASE_PATH_STAFF = "/QAT2 Output.json";      // file 2 -> staff_id based
const FIREBASE_PATH_PROJECT_TASK = "/qat_filtered.json"; // file 3 -> project+task based

// Railway / hosting port config
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// Default Team Leader / Staff IDs (used when no id list given via query params)
const TEAM_LEADERS = [
  "G26658-OTL",
  "G25883-OTL",
  "G22371-OTL",
  "G23179-OTL"
];

// Staff lookup sheet (shared)
const STAFF_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=1860286382&output=csv";

// Project/Task lookup sheet (shared) -- also source of denominator matrix
const PROJECT_TASK_SHEET_URL = () =>
  `https://docs.google.com/spreadsheets/d/e/2PACX-1vTcJSktGEdHycbjqLx-YD7-V1DUCH462h64XxaiuyKv9iK6n2FXgh6VAYvFEkS83DI76b2HJfppeuzd/pub?gid=822634964&output=csv&_=${Date.now()}`;

/*
|--------------------------------------------------------------------------
| HARDCODED BASIC AUTH
|--------------------------------------------------------------------------
| NOTE: production ekaka mewa environment variables walata gahanna hondai
| (process.env.AUTH_USER / process.env.AUTH_PASS), plain code eke thiyanawanam
| repo eka public unoth credentials leak wenawa.
|--------------------------------------------------------------------------
*/
const AUTH_USER = process.env.AUTH_USER || "admin";
const AUTH_PASS = process.env.AUTH_PASS || "password123";

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
| GRAFANA SESSION MANAGER
|--------------------------------------------------------------------------
| File 1 & 2 wලට tibuna login-based auto-refresh session manager eka use
| karanawa (File 3 wලට tibuna hard-coded grafana_session eka use karanne
| nehe -- eka expire unama okkoma crash wenawa).
|--------------------------------------------------------------------------
*/
let grafanaSession = null;
let loginPromise = null;

async function loginToGrafana() {
  console.log("🔐 Logging into Grafana to get fresh session...");

  const username = process.env.GRAFANA_USER || "gss.kurunegala@gssintl.biz";
  const password = process.env.GRAFANA_PASS || "Gssk@2021";

  try {
    const response = await axios.post(
      "https://monitor-public.trax-cloud.com/login",
      { user: username, password: password },
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

async function grafanaRequest(method, requestUrl, data = null, retryCount = 0) {
  try {
    const headers = await getGrafanaHeaders();
    const config = { headers, timeout: 30000 };
    let response;
    if (method === 'GET') {
      response = await axios.get(requestUrl, config);
    } else if (method === 'POST') {
      response = await axios.post(requestUrl, data, config);
    }
    return response;
  } catch (error) {
    if (error.response && (error.response.status === 401 || error.response.status === 403) && retryCount < 2) {
      console.warn("⚠️ Session expired or invalid. Refreshing Grafana session...");
      grafanaSession = null;
      loginPromise = null;
      return grafanaRequest(method, requestUrl, data, retryCount + 1);
    }
    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| BIGQUERY — poll until job complete (shared)
|--------------------------------------------------------------------------
*/
async function getQueryResults(resultUrl) {
  for (let i = 0; i < 10; i++) {
    const res = await grafanaRequest('GET', resultUrl);
    if (res.data.jobComplete) return res.data;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("BigQuery job timeout");
}

/*
|--------------------------------------------------------------------------
| BUILD SQL — 3 variants (tl_name / staff_id / project+task)
|--------------------------------------------------------------------------
*/
function buildQueryByTL(tlName) {
  const safe = String(tlName).replace(/'/g, "\\'");
  return {
    query: `
      #standardSQL
      SELECT
        TIMESTAMP_TRUNC(event_timestamp, HOUR) AS timestamp,
        project_name,
        task_name,
        staff_id,
        SUM(
          CASE
            WHEN LOWER(TRIM(task_name)) = 'stitching' THEN number_of_probes
            ELSE count
          END
        ) AS value
      FROM \`trax-retail.backoffice.tl_hourly_report\`
      WHERE
        event_timestamp BETWEEN
          TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY)
          AND CURRENT_TIMESTAMP()
        AND task_name    IS NOT NULL
        AND project_name IS NOT NULL
        AND team_leader_staff_id = '${safe}'
      GROUP BY 1, 2, 3, 4
      ORDER BY timestamp
    `,
    useLegacySql: false,
  };
}

function buildQueryByStaff(staffId) {
  const safe = String(staffId).replace(/'/g, "\\'");
  return {
    query: `
      #standardSQL
      SELECT
        TIMESTAMP_TRUNC(event_timestamp, HOUR) AS timestamp,
        project_name,
        task_name,
        staff_id,
        SUM(
          CASE
            WHEN LOWER(TRIM(task_name)) = 'stitching' THEN number_of_probes
            ELSE count
          END
        ) AS value
      FROM \`trax-retail.backoffice.tl_hourly_report\`
      WHERE
        event_timestamp BETWEEN
          TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY)
          AND CURRENT_TIMESTAMP()
        AND task_name    IS NOT NULL
        AND project_name IS NOT NULL
        AND staff_id = '${safe}'
      GROUP BY 1, 2, 3, 4
      ORDER BY timestamp
    `,
    useLegacySql: false,
  };
}

function buildQueryByProjectTask(project, task) {
  const safeProject = String(project).replace(/'/g, "\\'");
  const safeTask = String(task).replace(/'/g, "\\'");
  return {
    query: `
      #standardSQL
      SELECT
        TIMESTAMP_TRUNC(event_timestamp, HOUR) AS timestamp,
        project_name,
        task_name,
        staff_id,
        SUM(count) AS value
      FROM \`trax-retail.backoffice.tl_hourly_report\`
      WHERE
        event_timestamp BETWEEN
          TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY)
          AND CURRENT_TIMESTAMP()
        AND task_name IS NOT NULL
        AND project_name = '${safeProject}'
        AND task_name    = '${safeTask}'
      GROUP BY 1, 2, 3, 4
      ORDER BY timestamp
    `,
    useLegacySql: false,
  };
}

/*
|--------------------------------------------------------------------------
| PROCESS ROWS (shared)
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
    .map(obj => ({
      timestamp: obj.timestamp || "",
      project_name: obj.project_name || "",
      task_name: obj.task_name || "",
      staff_id: obj.staff_id || "",
      value: Number(obj.value || 0),
    }));
}

/*
|--------------------------------------------------------------------------
| DENOMINATOR LOOKUP (shared) — keys normalized (lowercase + trimmed)
|--------------------------------------------------------------------------
*/
const normKey = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');

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
    if (lines.length < 2) return { byProjectTask: {}, byGID: {}, rows: [] };

    const splitLine = (line) =>
      line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));

    const headerCells = splitLine(lines[0]);
    const taskNames = headerCells.slice(1).map(h => normKey(h));

    const denominatorMap = { byProjectTask: {}, byGID: {}, rows: [] };

    for (let i = 1; i < lines.length; i++) {
      const cells = splitLine(lines[i]);
      const project = normKey(cells[0] || '');
      if (!project) continue;

      for (let j = 1; j < cells.length; j++) {
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

    console.log(`✅ Loaded ${Object.keys(denominatorMap.byProjectTask).length} project/task denominators from matrix`);
    return denominatorMap;
  } catch (err) {
    console.error("❌ Failed to fetch denominator sheet:", err.message);
    return { byProjectTask: {}, byGID: {}, rows: [] };
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

function lookupDenominator(project, task, denominatorData) {
  const normTask = normKey(task);
  const normProject = normKey(project);
  const exactKey = `${normProject}||${normTask}`;
  if (denominatorData.byProjectTask[exactKey] !== undefined) {
    return denominatorData.byProjectTask[exactKey];
  }
  return taskFallback(normTask);
}

async function enrichWithDenominator(rows) {
  const denominatorData = await getDenominatorData();
  return rows.map(row => {
    const denominator = lookupDenominator(row.project_name, row.task_name, denominatorData);
    return {
      ...row,
      denominator,
      wd: row.value * denominator,
      count: row.value
    };
  });
}

/*
|--------------------------------------------------------------------------
| FIREBASE (shared saver — path passed in per feature)
|--------------------------------------------------------------------------
*/
async function saveToFirebase(path, payload) {
  await axios.put(`${FIREBASE_URL}${path}`, payload);
  console.log(`  Firebase updated at ${path}`);
}

/*
|--------------------------------------------------------------------------
| FEATURE 1: FETCH BY TEAM LEADER (tl_name) -> /TL Hourly.json
|--------------------------------------------------------------------------
*/
async function fetchSingleTL(tlName) {
  console.log(`  Fetching (TL): tl_name="${tlName}"`);
  const query = buildQueryByTL(tlName);
  const response = await grafanaRequest('POST', QUERY_URL, query);
  const jobId = response.data.jobReference.jobId;
  const location = response.data.jobReference.location;
  const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;
  const result = await getQueryResults(resultUrl);
  let rows = processResults(result);
  rows = await enrichWithDenominator(rows);

  return {
    tl_name: tlName,
    rows,
    total_rows: rows.length,
    fetched_at: new Date().toISOString()
  };
}

async function fetchAllTL(tlList) {
  const list = (tlList && tlList.length) ? tlList : TEAM_LEADERS;
  const results = await Promise.all(
    list.map(async (tlName) => {
      try {
        return await fetchSingleTL(tlName);
      } catch (err) {
        console.error(`  Error fetching TL ${tlName}:`, err.message);
        return { tl_name: tlName, error: err.message, rows: [], total_rows: 0, fetched_at: new Date().toISOString() };
      }
    })
  );
  return results;
}

/*
|--------------------------------------------------------------------------
| FEATURE 2: FETCH BY STAFF (staff_id) -> /QAT2 Output.json
|--------------------------------------------------------------------------
*/
async function fetchSingleStaff(staffId) {
  console.log(`  Fetching (Staff): staff_id="${staffId}"`);
  const query = buildQueryByStaff(staffId);
  const response = await grafanaRequest('POST', QUERY_URL, query);
  const jobId = response.data.jobReference.jobId;
  const location = response.data.jobReference.location;
  const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;
  const result = await getQueryResults(resultUrl);
  let rows = processResults(result);
  rows = await enrichWithDenominator(rows);

  return {
    staff_id: staffId,
    rows,
    total_rows: rows.length,
    fetched_at: new Date().toISOString()
  };
}

async function fetchAllStaff(staffIds) {
  const list = (staffIds && staffIds.length) ? staffIds : TEAM_LEADERS;
  const results = await Promise.all(
    list.map(async (staffId) => {
      try {
        return await fetchSingleStaff(staffId);
      } catch (err) {
        console.error(`  Error fetching staff ${staffId}:`, err.message);
        return { staff_id: staffId, error: err.message, rows: [], total_rows: 0, fetched_at: new Date().toISOString() };
      }
    })
  );
  return results;
}

/*
|--------------------------------------------------------------------------
| FEATURE 3: FETCH BY PROJECT + TASK -> /qat_filtered.json
|--------------------------------------------------------------------------
*/
async function fetchByProjectTask(project, task) {
  console.log(`  Fetching (Project/Task): project="${project}" task="${task}"`);
  const query = buildQueryByProjectTask(project, task);
  const response = await grafanaRequest('POST', QUERY_URL, query);
  const jobId = response.data.jobReference.jobId;
  const location = response.data.jobReference.location;
  const resultUrl = `${QUERY_URL}/${jobId}?location=${location}`;
  const result = await getQueryResults(resultUrl);
  const rows = processResults(result);
  return rows;
}

/*
|--------------------------------------------------------------------------
| SHARED LOOKUPS: STAFF SHEET / PROJECT-TASK SHEET / DENOMINATOR
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
      headers.forEach((header, idx) => { record[header] = cells[idx] || ''; });
      records.push(record);
    }

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
  // Accepts `ids=ID1,ID2,ID3` (or single value)
  const raw = query.staff_ids || query.tl_names || query.ids;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
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

  if (!authenticate(req)) {
    console.log(`  ❌ Unauthorized: ${req.url}`);
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="QAT Server"', "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  try {
    // Health check
    if (pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        service: "QAT Server (merged)",
        time: new Date().toISOString(),
        cors: "enabled"
      }));
      return;
    }

    /* ---------------- FEATURE 1: TL-based ---------------- */
    // GET /fetch-tl?tl_name=G26658-OTL
    if (pathname === "/fetch-tl" && req.method === "GET") {
      const tlName = String(parsed.query.tl_name || TEAM_LEADERS[0]).trim();
      const data = await fetchSingleTL(tlName);
      await saveToFirebase(FIREBASE_PATH_TL, {
        updated_at: new Date().toISOString(),
        total_rows: data.total_rows,
        filter_config: { tl_name: tlName },
        data: data.rows,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, rows: data.rows, total: data.total_rows, tl_name: tlName, updated_at: new Date().toISOString() }));
      return;
    }

    // GET /fetch-tl-all?tl_names=A,B,C
    if (pathname === "/fetch-tl-all" && req.method === "GET") {
      const requestedIds = parseIdsParam(parsed.query);
      const allData = await fetchAllTL(requestedIds);
      await saveToFirebase(FIREBASE_PATH_TL, {
        updated_at: new Date().toISOString(),
        total_leaders: allData.length,
        data: allData
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: allData, total_leaders: allData.length, updated_at: new Date().toISOString() }));
      return;
    }

    /* ---------------- FEATURE 2: Staff-based ---------------- */
    // GET /fetch-staff?staff_id=G26658-OTL   (canonical path)
    // GET /fetch?staff_id=G26658-OTL         (legacy alias, kept for existing frontend e.g. Dashboard.tsx)
    if ((pathname === "/fetch-staff" || pathname === "/fetch") && req.method === "GET") {
      const staffId = String(parsed.query.staff_id || TEAM_LEADERS[0]).trim();
      const data = await fetchSingleStaff(staffId);
      await saveToFirebase(FIREBASE_PATH_STAFF, {
        updated_at: new Date().toISOString(),
        total_rows: data.total_rows,
        filter_config: { staff_id: staffId },
        data: data.rows,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, rows: data.rows, total: data.total_rows, staff_id: staffId, updated_at: new Date().toISOString() }));
      return;
    }

    // GET /fetch-staff-all?staff_ids=A,B,C   (canonical path)
    // GET /fetch-all?staff_ids=A,B,C         (legacy alias, kept for existing frontend e.g. QATOutput2.tsx, Dashboard.tsx)
    if ((pathname === "/fetch-staff-all" || pathname === "/fetch-all") && req.method === "GET") {
      const requestedIds = parseIdsParam(parsed.query);
      const allData = await fetchAllStaff(requestedIds);
      await saveToFirebase(FIREBASE_PATH_STAFF, {
        updated_at: new Date().toISOString(),
        total_leaders: allData.length,
        data: allData
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: allData, total_leaders: allData.length, staff_ids: requestedIds.length ? requestedIds : TEAM_LEADERS, updated_at: new Date().toISOString() }));
      return;
    }

    /* ---------------- FEATURE 3: Project + Task ---------------- */
    // GET /fetch-project-task?project=XXX&task=YYY
    if (pathname === "/fetch-project-task" && req.method === "GET") {
      const project = String(parsed.query.project || "").trim();
      const task = String(parsed.query.task || "").trim();

      if (!project || !task) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "project සහ task දෙකම required" }));
        return;
      }

      const rows = await fetchByProjectTask(project, task);
      await saveToFirebase(FIREBASE_PATH_PROJECT_TASK, {
        updated_at: new Date().toISOString(),
        total_rows: rows.length,
        filter_config: { project, task },
        data: rows,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, rows, total: rows.length, project, task, updated_at: new Date().toISOString() }));
      return;
    }

    /* ---------------- SHARED LOOKUPS ---------------- */
    if (pathname === "/staff-lookup" && req.method === "GET") {
      const csv = await fetchStaffLookup();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ csv }));
      return;
    }

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

    if (pathname === "/denominator-lookup" && req.method === "GET") {
      try {
        const data = await getDenominatorData(true);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          data,
          count: { byProjectTask: Object.keys(data.byProjectTask).length, byGID: Object.keys(data.byGID).length }
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (pathname === "/team-leaders" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ team_leaders: TEAM_LEADERS, staff_ids: TEAM_LEADERS, count: TEAM_LEADERS.length }));
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (error) {
    console.error("❌ Server Error:", error.message);
    console.error("  Stack:", error.stack);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error.message, details: error.stack }));
  }
});

server.listen(PORT, HOST, () => {
  console.log("================================");
  console.log(`  🚀 QAT Server (merged) running on http://${HOST}:${PORT}`);
  console.log(`  🔐 Basic Auth: ${AUTH_USER} / ${AUTH_PASS}`);
  console.log(`  🌐 CORS: Enabled for all origins`);
  console.log(`  📊 Endpoints:`);
  console.log(`    GET  /                                     - Health check`);
  console.log(`    GET  /fetch-tl?tl_name=                     - Fetch by team leader        -> ${FIREBASE_PATH_TL}`);
  console.log(`    GET  /fetch-tl-all?tl_names=A,B,C           - Fetch all/list team leaders  -> ${FIREBASE_PATH_TL}`);
  console.log(`    GET  /fetch-staff?staff_id=                 - Fetch by staff_id            -> ${FIREBASE_PATH_STAFF}`);
  console.log(`    GET  /fetch-staff-all?staff_ids=A,B,C       - Fetch all/list staff_ids     -> ${FIREBASE_PATH_STAFF}`);
  console.log(`    GET  /fetch?staff_id=                       - (legacy alias of /fetch-staff)`);
  console.log(`    GET  /fetch-all?staff_ids=A,B,C             - (legacy alias of /fetch-staff-all)`);
  console.log(`    GET  /fetch-project-task?project=&task=     - Fetch by project+task        -> ${FIREBASE_PATH_PROJECT_TASK}`);
  console.log(`    GET  /staff-lookup                          - Staff name lookup (shared)`);
  console.log(`    GET  /project-task-lookup                   - Project/Task lookup (shared)`);
  console.log(`    GET  /denominator-lookup                    - Denominator lookup (shared)`);
  console.log(`    GET  /team-leaders                          - Default TL/staff id list`);
  console.log("================================");
});

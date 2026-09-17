const axios = require("axios");
const http = require("http");
const url = require("url");

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
| Meka thani server ekakin thanku data 3ma type eka handle karanawa:
|   1. Team Leader (team_leader_staff_id) fetch  -> /TL Hourly.json
|   2. Staff ID (staff_id) fetch                 -> /QAT2 Output.json
|   3. Project + Task filtered fetch             -> /qat_filtered.json
|
| Sema fetch mode 3ma dæn OPTIONAL `date=YYYY-MM-DD` query param eka
| support karanawa. Date eka denne nathnam (allathwa waradi format eka
| dunnoth) default eka widihata "today" (CURRENT_TIMESTAMP() up-to-the-
| minute) query eka run wenawa - meka appearance eken kalin behavior ekama.
| Past date ekak dunnoth, e dawase pura 24 pæya (00:00:00 sita 23:59:59.999999
| dakwa) BigQuery walin fetch karanawa.
|--------------------------------------------------------------------------
*/
const QUERY_URL =
  "https://monitor-public.trax-cloud.com/api/datasources/proxy/133/bigquery/v2/projects/trax-ortal-prod/queries";

const FIREBASE_URL = "https://qat-output-default-rtdb.firebaseio.com";

// Wenama Firebase path 3ka - features 3ta anuwa
const FIREBASE_PATH_TL       = "/TL Hourly.json";     // Team Leader mode
const FIREBASE_PATH_STAFF    = "/QAT2 Output.json";   // Staff ID mode
const FIREBASE_PATH_FILTERED = "/qat_filtered.json";  // Project/Task filtered mode

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
| HARDCODED BASIC AUTH
|--------------------------------------------------------------------------
*/
const AUTH_USER = "admin";
const AUTH_PASS = "password123";

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
| `date` query param eka `YYYY-MM-DD` format ekata match wenawada balala,
| SQL injection wenna bæ widihata sanitize karala, valid nam ema string eka
| return karanawa. Invalid/missing unoth `null` return karanawa (=> "today").
|--------------------------------------------------------------------------
*/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateParam(query) {
  const raw = query && query.date ? String(query.date).trim() : "";
  if (!raw) return null;
  if (!DATE_RE.test(raw)) return null;
  // Extra sanity check - make sure it's a real calendar date (e.g. rejects
  // 2026-02-31), not just a string that matches the shape.
  const [y, m, d] = raw.split("-").map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return raw;
}

// Builds the BigQuery WHERE-clause fragment for the requested day.
//  - No date (or invalid date) => same "today, up to right now" window as
//    the original queries always used.
//  - A specific past/present date => the full 00:00:00–23:59:59.999999
//    window for that calendar date.
function buildDateRangeClause(dateStr) {
  if (dateStr) {
    return `event_timestamp BETWEEN TIMESTAMP('${dateStr} 00:00:00') AND TIMESTAMP('${dateStr} 23:59:59.999999')`;
  }
  return `event_timestamp BETWEEN TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY) AND CURRENT_TIMESTAMP()`;
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

  const username = "gss.kurunegala@gssintl.biz";
  const password = "Gssk@2021";

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
| BUILD SQL — 3 variants (team leader / staff id / project+task)
|--------------------------------------------------------------------------
| Every builder now takes an optional `dateStr` (YYYY-MM-DD, already
| validated by parseDateParam) and swaps in the matching date-range clause.
|--------------------------------------------------------------------------
*/
function buildQueryByTeamLeader(tlName, dateStr) {
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
        AND team_leader_staff_id = '${tlName}'
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

/*
|--------------------------------------------------------------------------
| TEMPLATE NAME LOOKUP
|--------------------------------------------------------------------------
| Some tasks share the same underlying UI/template, so we tag them with a
| common `template_name` value. Only the tasks listed below get a
| template_name - everything else gets null (no template_name grouping).
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
      // template_name eka row ekata attach karanne "voting/validation"
      // vage TEMPLATE_NAME_TASKS walata witharak neme - PGES walatath
      // (task eka monawa unath) denominator lookup eka (Repair Only vs
      // Repair & Attribute) template_name uda depend wena nisa eka
      // danna oni. Meka nathnam lookupDenominator ekata templateName
      // ehema undefined widihata yanawa, e nisa PGES ta hamadama
      // "Repair & Attribute" witharak select wela "Repair Only" (Display)
      // case eka never trigger wenne nathi.
      const isPges = normKeySimple(obj.project_name) === 'pges';
      if ((isTemplateNameTask(obj.task_name) || isPges) && obj.template_name) {
        row.template_name = obj.template_name;
      }
      return row;
    });
}

/*
|--------------------------------------------------------------------------
| FIREBASE SAVE (path parameter eken kaka data save karanawada kiyala decide karanawa)
|--------------------------------------------------------------------------
*/
async function saveToFirebase(firebasePath, payload) {
  await axios.put(`${FIREBASE_URL}${firebasePath}`, payload);
  console.log(`  🔥 Firebase updated at "${firebasePath}"`);
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
| They are NOT row-aligned - row N of table 1 and row N of table 2 belong
| to completely different projects, they just happen to sit on the same
| CSV line. Row 1 of the CSV is a merged title row ("Denominator Sheet" /
| "UF Denominator ") - the REAL column headers are on row 2, and data
| starts on row 3.
|--------------------------------------------------------------------------
*/
const normKey = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');

// Projects that should primarily resolve their denominator from the UF
// Denominator table's "Menu" rows before falling back to the main matrix /
// hardcoded fallback.
const UF_PRIORITY_PROJECTS = new Set([
  'diageopl', 'diageoes', 'diageopebac', 'diageoromania', 'aneuae',
  'rjreynoldsus', 'diageomx', 'diageobenelux', 'diageoga', 'diageoza',
  'diageoug', 'diageoca', 'diageouk', 'diageoit', 'diageoco', 'diageotz',
  'frucorau', 'diageogr', 'diageoin', 'diageoie', 'diageoar', 'diageoke',
  'diageostr', 'diageogtr'
].map(normKey));

// When matching against the UF Denominator table, voting/offline_voting are
// treated as the same task, and validation/offline_validation are treated
// as the same task.
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

// Column headers that appear in the main "Denominator Sheet" table's header
// row but are NOT task columns (they end the task-column range).
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
    // Row 1 (index 0) is the merged title row ("Denominator Sheet" / "UF
    // Denominator "), row 2 (index 1) has the real column headers, data
    // starts at row 3 (index 2).
    if (lines.length < 3) return { byProjectTask: {}, byGID: {}, rows: [], uf: {}, ufRowsByProject: {} };

    const splitLine = (line) =>
      line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));

    const headerCells = splitLine(lines[1]);

    // Find where the main table's task columns end (first blank header,
    // or a known non-task header like VLOOKUP/Region).
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

// Finds the best UF Denominator table row for (project, task), where task
// equivalence (voting<->offline_voting, validation<->offline_validation)
// applies across the WHOLE UF table for that project - not just "Menu"
// rows. An exact task match always wins over an equivalent-task match, and
// a "Menu" subtask row always wins over any other subtask, so:
//   1. exact task, subtask = Menu
//   2. exact task, any other subtask   (e.g. offline_voting -> offline_voting)
//   3. equivalent task, subtask = Menu
//   4. equivalent task, any other subtask
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

// Finds a UF Denominator table row for (project, task, subtask) - used for
// PGES's "Repair Only" / "Repair & Attribute" rows - where task equivalence
// still applies (exact task match preferred over an equivalent-task match).
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

function lookupDenominator(project, task, denominatorData, templateName) {
  const normProject = normKey(project);
  const normTask    = normKey(task);
  const ufRowsByProject = denominatorData.ufRowsByProject || {};

  // Special case: PGES resolves its denominator from the UF table using
  // "Repair Only" when the row's own template_name is "display", and
  // "Repair & Attribute" for every other template_name.
  if (normProject === 'pges') {
    const subtask = normKey(templateName) === 'display' ? 'Repair Only' : 'Repair & Attribute';
    const ufValue = findUFDenominatorBySubtask(normProject, normTask, subtask, ufRowsByProject);
    if (ufValue !== undefined) return ufValue;
  } else if (UF_PRIORITY_PROJECTS.has(normProject)) {
    // Priority projects: primarily resolve from the UF Denominator table,
    // treating voting/offline_voting and validation/offline_validation as
    // the same task when searching it.
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
| FETCH — MODE 3: Project + Task filtered (no denominator enrichment,
| matches original behaviour of the filtered-only server)
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
  // `ids=A,B,C` or single `id=A` style params (used for staff_ids/tl_names)
  const raw = query.staff_ids || query.staff_id || query.tl_names || query.tl_name;
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

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  // NOTE: The original "Project+Task filtered" frontend never sent Basic
  // Auth credentials (its source server had no auth check at all), so we
  // exempt /fetch-filtered here to match that frontend's existing behaviour.
  // Every other endpoint keeps requiring Basic Auth like before.
  const AUTH_EXEMPT_PATHS = ["/fetch-filtered"];
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
        service: "QAT Server - Unified (TL / Staff ID / Project-Task)",
        time: new Date().toISOString(),
        cors: "enabled"
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
    // Both accept an optional &date=YYYY-MM-DD
    // -------------------------------------------------------------
    if (pathname === "/fetch" && req.method === "GET") {
      const dateStr = parseDateParam(query);

      // staff_id takes priority if both are supplied
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
  console.log(`  🔐 Basic Auth: ${AUTH_USER} / ${AUTH_PASS}`);
  console.log(`  🌐 CORS: Enabled for all origins`);
  console.log(`  🔥 Firebase paths:`);
  console.log(`     TL mode      -> ${FIREBASE_PATH_TL}`);
  console.log(`     Staff mode   -> ${FIREBASE_PATH_STAFF}`);
  console.log(`     Filtered     -> ${FIREBASE_PATH_FILTERED}`);
  console.log(`  📊 Endpoints (all accept optional &date=YYYY-MM-DD):`);
  console.log(`    GET  /                                  - Health check`);
  console.log(`    GET  /fetch-all?mode=tl                 - Fetch all Team Leaders -> ${FIREBASE_PATH_TL}`);
  console.log(`    GET  /fetch-all?mode=staff&staff_ids=A,B - Fetch given staff_ids -> ${FIREBASE_PATH_STAFF}`);
  console.log(`    GET  /fetch?tl_name=                    - Single TL fetch -> ${FIREBASE_PATH_TL}`);
  console.log(`    GET  /fetch?staff_id=                   - Single staff fetch -> ${FIREBASE_PATH_STAFF}`);
  console.log(`    GET  /fetch-filtered?project=&task=     - Project+Task filtered -> ${FIREBASE_PATH_FILTERED}`);
  console.log(`    GET  /staff-lookup                      - Staff name lookup`);
  console.log(`    GET  /project-task-lookup                - Project/Task lookup`);
  console.log(`    GET  /denominator-lookup                 - Denominator lookup`);
  console.log(`    GET  /team-leaders | /staff-ids          - Default ID list`);
  console.log("================================");
});

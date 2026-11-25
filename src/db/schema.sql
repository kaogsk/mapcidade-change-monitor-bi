-- BI database (own database: the sources are read-only). Idempotent: applied on every open.
--
-- Sources:
--   register   typed in the Register screen (replaced the team's control spreadsheet):
--              contract, cycle_schedule, site_visit, monthly_report, holiday, option_list
--   support    consolidated change-alert table, filled by an external ETL 4x a day:
--              alert + alert_status_history + alert_daily_snapshot
--   cities     each monitored city's edit log: edit_day, alert_analyzed_day, alert_touch_day
--
-- Days are ISO text (YYYY-MM-DD); instants are ISO UTC text. Functions registered in db/bi.ts:
--   status_group(s), workday_add(day, n), business_days(from, to), percentile_cont(v, p).

-- =====================================================================================
-- Register
-- =====================================================================================
-- `version` = optimistic lock (saving with an old version gives 409); updated_* = last writer.
CREATE TABLE IF NOT EXISTS contract (
    code            TEXT PRIMARY KEY,           -- project code, same as alert.project_code
    municipality    TEXT NOT NULL,
    contract_no     TEXT,
    starts_on       TEXT,
    ends_on         TEXT,
    frequency       TEXT,
    total_cycles    INTEGER,
    area_km2        REAL,                       -- monitored area per cycle
    total_area_km2  REAL,                       -- calc: total_cycles × area_km2
    status          TEXT,
    version         INTEGER NOT NULL DEFAULT 1,
    updated_at      TEXT,
    updated_by      TEXT
);

-- One row per project × cycle (the spreadsheet allowed a repeated cycle: duplicate_cycle flags it).
CREATE TABLE IF NOT EXISTS cycle_schedule (
    id                   INTEGER PRIMARY KEY,
    municipality         TEXT,
    code                 TEXT NOT NULL,
    cycle                INTEGER,
    frequency            TEXT,                  -- calc: contract frequency
    capture_start        TEXT,
    capture_end          TEXT,
    capture_status       TEXT,
    production_days      INTEGER,               -- business days to produce the change product
    product_deadline     TEXT,                  -- calc: WORKDAY(capture_end, production_days)
    product_expected     TEXT,                  -- calc: same formula, separate column in the sheet
    product_delivered    TEXT,
    rollout_opened_on    TEXT,                  -- rollout ticket opened
    rollout_days         INTEGER,               -- business days to roll out
    rollout_expected     TEXT,                  -- calc: WORKDAY(rollout_opened_on, rollout_days)
    cycle_term_days      INTEGER,               -- calendar days after the product deadline
    cycle_deadline       TEXT,                  -- calc when cycle_term_days is set; typed otherwise
    cycle_delivered      TEXT,
    slack_days           INTEGER,               -- calc: cycle_deadline − cycle_delivered (+ slack, − late)
    km2_done             REAL,                  -- calc: contract area when the cycle was delivered, else 0
    signature_planned    TEXT,                  -- calc: cycle_deadline + 14
    request_no           TEXT,
    request_signed_on    TEXT,
    duplicate_cycle      INTEGER NOT NULL DEFAULT 0,
    manual               TEXT NOT NULL DEFAULT '[]',  -- JSON array: calc columns typed over the formula
    version              INTEGER NOT NULL DEFAULT 1,
    updated_at           TEXT,
    updated_by           TEXT
);
CREATE INDEX IF NOT EXISTS idx_cycle_schedule_code ON cycle_schedule (code, cycle);

CREATE TABLE IF NOT EXISTS site_visit (
    id             INTEGER PRIMARY KEY,
    municipality   TEXT,
    code           TEXT NOT NULL,
    cycle          INTEGER,
    responsible    TEXT,
    starts_on      TEXT,
    ends_on        TEXT,
    duration_days  INTEGER,
    reason         TEXT,                        -- 'Assisted operation' marks the assisted-operation visit
    departments    TEXT,
    actions        TEXT,
    version        INTEGER NOT NULL DEFAULT 1,
    updated_at     TEXT,
    updated_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_site_visit_code ON site_visit (code, starts_on);

CREATE TABLE IF NOT EXISTS monthly_report (
    id              INTEGER PRIMARY KEY,
    project         TEXT NOT NULL,
    municipality    TEXT,                       -- calc: contract municipality
    project_status  TEXT,                       -- calc: contract status
    measurement     INTEGER,
    responsible     TEXT,
    due_on          TEXT,
    delivered_on    TEXT,
    status          TEXT,                       -- calc: 'Delivered' when delivered_on is set
    delay_days      INTEGER,                    -- calc: delivered_on − due_on
    planned_hours   REAL,
    actual_hours    REAL,
    version         INTEGER NOT NULL DEFAULT 1,
    updated_at      TEXT,
    updated_by      TEXT
);

CREATE TABLE IF NOT EXISTS holiday (
    day         TEXT PRIMARY KEY,
    reason      TEXT,
    version     INTEGER NOT NULL DEFAULT 1,
    updated_at  TEXT,
    updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS option_list (
    id          INTEGER PRIMARY KEY,
    list        TEXT NOT NULL,
    value       TEXT NOT NULL,
    position    INTEGER,
    version     INTEGER NOT NULL DEFAULT 1,
    updated_at  TEXT,
    updated_by  TEXT,
    UNIQUE (list, value)
);

-- Who changed what (replaces the spreadsheet's version history). `key` = id / code / day.
CREATE TABLE IF NOT EXISTS register_history (
    id        INTEGER PRIMARY KEY,
    entity    TEXT NOT NULL,
    key       TEXT,
    action    TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'import')),
    username  TEXT,
    at        TEXT NOT NULL,
    before    TEXT,
    after     TEXT
);
CREATE INDEX IF NOT EXISTS idx_register_history_at ON register_history (at DESC);
CREATE INDEX IF NOT EXISTS idx_register_history_key ON register_history (entity, key, at DESC);

-- =====================================================================================
-- Alerts (copy of the consolidated table, only the columns the screens use)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS alert (
    database               TEXT NOT NULL,
    alert_id               INTEGER NOT NULL,
    city                   TEXT,
    project_code           TEXT,
    project_cycle          TEXT,
    frequency              TEXT,
    alert_class            TEXT,
    detection_cycle        TEXT,
    detected_on            TEXT,                -- parsed from text: YYYY-MM-DD or DD/MM/YYYY
    area_m2                REAL,
    responsibility         TEXT,
    responsibility_profile TEXT,
    status                 TEXT,
    final_status           TEXT,
    acted_on               TEXT,                -- last update of the alert (the old dashboard's date)
    loaded_at              TEXT NOT NULL,
    PRIMARY KEY (database, alert_id)
);
CREATE INDEX IF NOT EXISTS idx_alert_project ON alert (project_code, acted_on);

-- One row per period an alert stayed in a status (the source only keeps the current one).
-- since NULL = already like that on the BI's first load; status '(removed)' = left the source.
CREATE TABLE IF NOT EXISTS alert_status_history (
    id        INTEGER PRIMARY KEY,
    database  TEXT NOT NULL,
    alert_id  INTEGER NOT NULL,
    status    TEXT NOT NULL,
    since     TEXT,
    until     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_history_open ON alert_status_history (database, alert_id) WHERE until IS NULL;

-- Daily snapshot: count and area per database × project × cycle × class × responsibility × status.
-- It is STOCK (how many alerts existed that day), not flow: summing different days is meaningless.
-- The last ETL run of the day replaces earlier ones.
CREATE TABLE IF NOT EXISTS alert_daily_snapshot (
    day             TEXT NOT NULL,
    database        TEXT NOT NULL,
    city            TEXT,
    project_code    TEXT,
    project_cycle   TEXT,
    alert_class     TEXT,
    responsibility  TEXT,
    status          TEXT NOT NULL,              -- '(no status)' when empty at the source
    alerts          INTEGER NOT NULL,
    analyzed        INTEGER NOT NULL,           -- of those, alerts with at least one inspection edit
    area_m2         REAL,
    written_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_daily_snapshot ON alert_daily_snapshot (day, database);

-- =====================================================================================
-- From each city's edit log
-- =====================================================================================
-- Edits by the monitoring profiles, aggregated per day (see etl/sql/edits.sql for the rule).
CREATE TABLE IF NOT EXISTS edit_day (
    database      TEXT NOT NULL,
    day           TEXT NOT NULL,
    profile       TEXT NOT NULL,
    table_name    TEXT NOT NULL,
    action        TEXT NOT NULL,               -- insert | update | delete
    channel       TEXT NOT NULL,               -- gis | mobile | import
    username      TEXT NOT NULL,
    module_table  INTEGER NOT NULL,            -- 1 = a change-module table (chg_*)
    n             INTEGER NOT NULL,
    PRIMARY KEY (database, day, profile, table_name, action, channel, username)
);
CREATE INDEX IF NOT EXISTS idx_edit_day ON edit_day (day);

-- Alerts analyzed per day: DISTINCT inspection records with insert/update that day, per user and
-- channel. `alerts` is distinct per user × channel: summing users counts twice an alert two
-- people touched the same day.
CREATE TABLE IF NOT EXISTS alert_analyzed_day (
    database  TEXT NOT NULL,
    day       TEXT NOT NULL,
    profile   TEXT NOT NULL,
    username  TEXT NOT NULL,
    channel   TEXT NOT NULL,
    edits     INTEGER NOT NULL,
    alerts    INTEGER NOT NULL,
    PRIMARY KEY (database, day, profile, username, channel)
);
CREATE INDEX IF NOT EXISTS idx_alert_analyzed_day ON alert_analyzed_day (day);

-- Per alert and day: inspection edits on that alert. The join key between the consolidated alert
-- and the city's edit log; v_alert_response derives "analyzed?" and "how long until analyzed".
CREATE TABLE IF NOT EXISTS alert_touch_day (
    database  TEXT NOT NULL,
    alert_id  INTEGER NOT NULL,
    day       TEXT NOT NULL,
    edits     INTEGER NOT NULL,
    mobile    INTEGER NOT NULL,
    PRIMARY KEY (database, alert_id, day)
);
CREATE INDEX IF NOT EXISTS idx_alert_touch_day ON alert_touch_day (day);

-- =====================================================================================
-- Monitored databases and ETL control
-- =====================================================================================
CREATE TABLE IF NOT EXISTS monitored_db (
    database          TEXT PRIMARY KEY,
    host              TEXT,
    port              INTEGER,
    active            INTEGER NOT NULL DEFAULT 1,  -- still listed by the support database
    source_id         TEXT,                        -- entry of sources.json used for the edit log
    city              TEXT,
    alerts_loaded_at  TEXT,                        -- last good copy of this database's alerts
    alerts_source_at  TEXT,                        -- consolidation run that copy came from
    edits_until       TEXT,                        -- watermark: last day of edit log extracted
    analyses_until    TEXT,
    updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS etl_run (
    id           INTEGER PRIMARY KEY,
    routine      TEXT NOT NULL,                    -- full | alerts+edits | …
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    status       TEXT NOT NULL DEFAULT 'running',  -- running | ok | with_failures | error
    summary      TEXT NOT NULL DEFAULT '{}',
    error        TEXT
);

CREATE TABLE IF NOT EXISTS etl_db (
    run_id    INTEGER NOT NULL REFERENCES etl_run (id) ON DELETE CASCADE,
    database  TEXT NOT NULL,
    routine   TEXT NOT NULL,
    status    TEXT NOT NULL,                       -- ok | kept | error
    rows      INTEGER,
    message   TEXT,
    PRIMARY KEY (run_id, database, routine)
);

-- =====================================================================================
-- Usage of the BI itself
-- =====================================================================================
CREATE TABLE IF NOT EXISTS bi_access (
    id                INTEGER PRIMARY KEY,
    username          TEXT NOT NULL,
    ip                TEXT,
    user_agent        TEXT,
    signed_in_at      TEXT NOT NULL,
    local_day         TEXT NOT NULL,
    signed_out_at     TEXT,
    duration_seconds  INTEGER
);

-- One row per screen opened, API query of a screen (filters, status, response time) and export.
-- `filters` holds only the global and click filters, which do not identify people. 400-day
-- retention, purged by the ETL.
CREATE TABLE IF NOT EXISTS bi_event (
    id              INTEGER PRIMARY KEY,
    occurred_at     TEXT NOT NULL,
    local_day       TEXT NOT NULL,
    username        TEXT NOT NULL,
    access_id       INTEGER,
    kind            TEXT NOT NULL CHECK (kind IN ('screen', 'query', 'export')),
    screen          TEXT NOT NULL,
    resource        TEXT,
    filters         TEXT,
    municipalities  INTEGER,
    http_status     INTEGER,
    duration_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bi_event_at ON bi_event (occurred_at DESC);

-- =====================================================================================
-- Views
-- =====================================================================================
-- One project per code, joining contracts, schedule and alerts: some contracts have no schedule
-- yet, and in the old dashboard they vanished from the filters. `database` = where its alerts are.
DROP VIEW IF EXISTS v_project;
CREATE VIEW v_project AS
WITH codes AS (
    SELECT code FROM contract
    UNION SELECT code FROM cycle_schedule
    UNION SELECT DISTINCT project_code FROM alert WHERE project_code IS NOT NULL
), sched AS (
    SELECT code, min(municipality) AS municipality, min(lower(frequency)) AS frequency FROM cycle_schedule GROUP BY code
), al AS (
    SELECT project_code AS code, min(city) AS municipality, min(lower(frequency)) AS frequency, min(database) AS database
      FROM alert GROUP BY project_code
)
SELECT c.code,
       coalesce(k.municipality, s.municipality, a.municipality) AS municipality,
       coalesce(lower(k.frequency), s.frequency, a.frequency)   AS frequency,
       k.status,
       a.database
  FROM codes c
  LEFT JOIN contract k ON k.code = c.code
  LEFT JOIN sched s ON s.code = c.code
  LEFT JOIN al a ON a.code = c.code;

-- The alert × edit-log crossing: was each alert analyzed in the city, when first, and was it
-- answered (status in the Finished group)?
DROP VIEW IF EXISTS v_alert_response;
CREATE VIEW v_alert_response AS
SELECT a.database, a.alert_id, a.city, a.project_code, a.project_cycle, a.alert_class, a.responsibility,
       a.status, status_group(a.status)                          AS status_group,
       a.detected_on,
       t.first_day                                              AS first_analyzed_on,
       t.last_day                                               AS last_analyzed_on,
       coalesce(t.edits, 0)                                     AS edits,
       coalesce(t.mobile, 0)                                    AS mobile_edits,
       t.first_day IS NOT NULL                                  AS analyzed,
       status_group(a.status) = 'Finished'                      AS answered,
       CASE WHEN t.first_day IS NOT NULL AND a.detected_on IS NOT NULL AND t.first_day >= a.detected_on
            THEN business_days(a.detected_on, t.first_day) - 1 END AS business_days_to_first
  FROM alert a
  LEFT JOIN (SELECT database, alert_id, min(day) AS first_day, max(day) AS last_day,
                    sum(edits) AS edits, sum(mobile) AS mobile
               FROM alert_touch_day GROUP BY database, alert_id) t
    ON t.database = a.database AND t.alert_id = a.alert_id;

-- Daily stock per city, project and status group (pending / in analysis / finished over time).
DROP VIEW IF EXISTS v_alert_stock_day;
CREATE VIEW v_alert_stock_day AS
SELECT day, database, max(city) AS city, project_code, status_group(status) AS status_group,
       sum(alerts) AS alerts, sum(analyzed) AS analyzed, sum(area_m2) AS area_m2
  FROM alert_daily_snapshot
 GROUP BY day, database, project_code, status_group(status);

-- Usage per month and person: sign-ins + screens, queries and exports.
DROP VIEW IF EXISTS v_usage_monthly;
CREATE VIEW v_usage_monthly AS
WITH a AS (
    SELECT substr(local_day, 1, 7) AS month, username, count(*) AS sign_ins, sum(duration_seconds) AS session_seconds
      FROM bi_access GROUP BY 1, 2
), e AS (
    SELECT substr(local_day, 1, 7) AS month, username,
           sum(kind = 'screen') AS screens_opened, sum(kind = 'query') AS queries, sum(kind = 'export') AS exports,
           count(DISTINCT local_day) AS active_days,
           count(DISTINCT CASE WHEN kind = 'screen' THEN screen END) AS distinct_screens
      FROM bi_event GROUP BY 1, 2
), k AS (SELECT month, username FROM a UNION SELECT month, username FROM e)
SELECT k.month, k.username, coalesce(a.sign_ins, 0) AS sign_ins, a.session_seconds,
       coalesce(e.active_days, 0) AS active_days, coalesce(e.screens_opened, 0) AS screens_opened,
       coalesce(e.distinct_screens, 0) AS distinct_screens, coalesce(e.queries, 0) AS queries,
       coalesce(e.exports, 0) AS exports
  FROM k
  LEFT JOIN a ON a.month = k.month AND a.username = k.username
  LEFT JOIN e ON e.month = k.month AND e.username = k.username;

-- Usage per month and screen: who opens it, exports, and API latency (p50 / p95) and errors.
DROP VIEW IF EXISTS v_usage_screen_monthly;
CREATE VIEW v_usage_screen_monthly AS
SELECT substr(local_day, 1, 7) AS month, screen,
       count(DISTINCT username)                                         AS users,
       sum(kind = 'screen')                                             AS opens,
       sum(kind = 'export')                                             AS exports,
       sum(kind = 'query')                                              AS queries,
       percentile_cont(CASE WHEN kind = 'query' THEN duration_ms END, 0.5)  AS query_ms_p50,
       percentile_cont(CASE WHEN kind = 'query' THEN duration_ms END, 0.95) AS query_ms_p95,
       sum(kind = 'query' AND http_status >= 500)                       AS query_errors
  FROM bi_event
 GROUP BY 1, 2;

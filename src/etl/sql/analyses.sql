-- Alerts analyzed in ONE city: DISTINCT inspection records (chg_inspection*) with INSERT or UPDATE,
-- per day, profile, user and channel. Same profile/user rules as edits.sql. SELECT only.
--
-- Why not the alert's own "acted on" date: it is the date of the alert's LAST version, and it
-- piles up on the days the consolidation reloads, so it measures the loader, not the people.
SELECT substr(l.logged_at, 1, 10)                                              AS day,
       coalesce(p.name, '(no profile)')                                        AS profile,
       coalesce(lower(u.name), 'user ' || l.user_id, '(no user)')              AS username,
       CASE WHEN coalesce(l.endpoint, '') LIKE '%/rest/mobile/%' THEN 'mobile'
            WHEN coalesce(l.endpoint, '') LIKE '%/import/%' THEN 'import'
            ELSE 'gis' END                                                     AS channel,
       count(*)                                                                AS edits,
       count(DISTINCT l.record_id)                                             AS alerts
  FROM edit_log l
  LEFT JOIN user_account u ON u.id = l.user_id
  LEFT JOIN user_profile p ON p.id = l.profile_id
 WHERE l.logged_at >= $from
   AND l.logged_at <  date($to, '+1 day')
   AND l.action IN ('insert', 'update')
   AND l.table_name LIKE 'chg\_inspection%' ESCAPE '\'
   AND coalesce(p.name, '') NOT LIKE '%mapcidade%'
   AND coalesce(u.email, '') NOT LIKE '%@mapcidade.example'
 GROUP BY 1, 2, 3, 4

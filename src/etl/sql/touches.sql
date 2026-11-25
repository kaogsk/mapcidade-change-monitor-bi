-- Per alert and day: inspection edits on that alert in ONE city. The inspection record is keyed
-- by the alert id, so record_id joins straight to the consolidated alert. Same rules as
-- analyses.sql. SELECT only.
SELECT substr(l.logged_at, 1, 10)                                                     AS day,
       l.record_id                                                                    AS alert_id,
       count(*)                                                                       AS edits,
       sum(CASE WHEN coalesce(l.endpoint, '') LIKE '%/rest/mobile/%' THEN 1 ELSE 0 END) AS mobile
  FROM edit_log l
  LEFT JOIN user_account u ON u.id = l.user_id
  LEFT JOIN user_profile p ON p.id = l.profile_id
 WHERE l.logged_at >= $from
   AND l.logged_at <  date($to, '+1 day')
   AND l.action IN ('insert', 'update')
   AND l.table_name LIKE 'chg\_inspection%' ESCAPE '\'
   AND l.record_id IS NOT NULL
   AND coalesce(p.name, '') NOT LIKE '%mapcidade%'
   AND coalesce(u.email, '') NOT LIKE '%@mapcidade.example'
 GROUP BY 1, 2

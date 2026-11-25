-- Edits by the monitoring profiles in ONE city's edit log, aggregated per day. SELECT only.
-- $from = first day (inclusive), $to = last day (inclusive).
--
-- What counts (agreed with the monitoring team): INSERT, UPDATE and DELETE
--   * by a profile named 'Monitoring%' (any table), or
--   * on a change-module table 'chg_%' (any profile);
-- never the vendor's own staff (vendor profile or vendor e-mail): they fix data, they don't analyze.
-- The screen filters further by module_table (default: module tables only) and by action.
-- Channel: endpoint /rest/mobile/ = field app; /import/ = file import; anything else = desktop GIS.
SELECT substr(l.logged_at, 1, 10)                                              AS day,
       coalesce(p.name, '(no profile)')                                        AS profile,
       coalesce(l.table_name, '(no table)')                                    AS table_name,
       l.action                                                                AS action,
       CASE WHEN coalesce(l.endpoint, '') LIKE '%/rest/mobile/%' THEN 'mobile'
            WHEN coalesce(l.endpoint, '') LIKE '%/import/%' THEN 'import'
            ELSE 'gis' END                                                     AS channel,
       coalesce(lower(u.name), 'user ' || l.user_id, '(no user)')              AS username,
       coalesce(l.table_name, '') LIKE 'chg\_%' ESCAPE '\'                     AS module_table,
       count(*)                                                                AS n
  FROM edit_log l
  LEFT JOIN user_account u ON u.id = l.user_id
  LEFT JOIN user_profile p ON p.id = l.profile_id
 WHERE l.logged_at >= $from
   AND l.logged_at <  date($to, '+1 day')
   AND l.action IN ('insert', 'update', 'delete')
   AND (p.name LIKE 'Monitoring%' OR coalesce(l.table_name, '') LIKE 'chg\_%' ESCAPE '\')
   AND coalesce(p.name, '') NOT LIKE '%mapcidade%'
   AND coalesce(u.email, '') NOT LIKE '%@mapcidade.example'
 GROUP BY 1, 2, 3, 4, 5, 6, 7

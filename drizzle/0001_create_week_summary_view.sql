-- Slate Dashboard read shape — one row per game per week.
--
-- Decision provenance:
--   - View-as-read-shape pattern:           ADR-0009
--   - Edge formula and sign convention:     ADR-0002
--   - Snapshot pattern (week = g.week - 1): docs/schema-design.md
--   - Slice 1 view shape (no odds yet):     grilling Q8
--
-- Column ordering is deliberate: CREATE OR REPLACE VIEW can ADD columns at
-- the end of the column list but cannot reorder or retype existing ones.
-- Future slices append columns (most-recent line snapshot, etc.) at the end.
-- Do NOT reshape existing columns — write a new view or drop+recreate.
--
-- Edge formula (ADR-0002):
--   matchup_edge = offensive_epa_per_play + defensive_epa_per_play
--   (defensive sign is "what they allow" — negative = good defense.
--    Addition is correct; the sign convention already encodes direction.)
--   Positive edge favours offence; negative favours defence.

CREATE VIEW "week_summary" AS
SELECT
  -- Identity & game context
  g.id                                                                  AS "game_id",
  g.season_id                                                           AS "season_id",
  g.week                                                                AS "week",
  g.game_type                                                           AS "game_type",
  g.game_date_time                                                      AS "game_date_time",
  g.is_neutral_site                                                     AS "is_neutral_site",
  g.is_international                                                    AS "is_international",
  -- Weather
  g.temperature                                                         AS "temperature",
  g.wind_mph                                                            AS "wind_mph",
  g.precipitation_chance                                                AS "precipitation_chance",
  g.weather_condition                                                   AS "weather_condition",
  -- Home team identity & standing
  g.home_team_id                                                        AS "home_team_id",
  ht.abbreviation                                                       AS "home_team_abbreviation",
  hws.record_wins                                                       AS "home_record_wins",
  hws.record_losses                                                     AS "home_record_losses",
  hws.record_ties                                                       AS "home_record_ties",
  hws.elo_rating                                                        AS "home_elo_rating",
  hws.sos_rank                                                          AS "home_sos_rank",
  -- Home team EPA
  hws.overall_epa_per_play                                              AS "home_overall_epa_per_play",
  hws.offensive_epa_per_play                                            AS "home_offensive_epa_per_play",
  hws.defensive_epa_per_play                                            AS "home_defensive_epa_per_play",
  hws.offensive_pass_epa_per_play                                       AS "home_offensive_pass_epa_per_play",
  hws.offensive_rush_epa_per_play                                       AS "home_offensive_rush_epa_per_play",
  hws.defensive_pass_epa_per_play                                       AS "home_defensive_pass_epa_per_play",
  hws.defensive_rush_epa_per_play                                       AS "home_defensive_rush_epa_per_play",
  -- Away team identity & standing
  g.away_team_id                                                        AS "away_team_id",
  awt.abbreviation                                                      AS "away_team_abbreviation",
  aws.record_wins                                                       AS "away_record_wins",
  aws.record_losses                                                     AS "away_record_losses",
  aws.record_ties                                                       AS "away_record_ties",
  aws.elo_rating                                                        AS "away_elo_rating",
  aws.sos_rank                                                          AS "away_sos_rank",
  -- Away team EPA
  aws.overall_epa_per_play                                              AS "away_overall_epa_per_play",
  aws.offensive_epa_per_play                                            AS "away_offensive_epa_per_play",
  aws.defensive_epa_per_play                                            AS "away_defensive_epa_per_play",
  aws.offensive_pass_epa_per_play                                       AS "away_offensive_pass_epa_per_play",
  aws.offensive_rush_epa_per_play                                       AS "away_offensive_rush_epa_per_play",
  aws.defensive_pass_epa_per_play                                       AS "away_defensive_pass_epa_per_play",
  aws.defensive_rush_epa_per_play                                       AS "away_defensive_rush_epa_per_play",
  -- Per-matchup edges
  (hws.offensive_pass_epa_per_play + aws.defensive_pass_epa_per_play)   AS "home_pass_edge",
  (hws.offensive_rush_epa_per_play + aws.defensive_rush_epa_per_play)   AS "home_rush_edge",
  (aws.offensive_pass_epa_per_play + hws.defensive_pass_epa_per_play)   AS "away_pass_edge",
  (aws.offensive_rush_epa_per_play + hws.defensive_rush_epa_per_play)   AS "away_rush_edge",
  -- Top edge — largest absolute value among the four matchups.
  -- Tie-break order (deterministic): home_pass > home_rush > away_pass > away_rush.
  CASE
    WHEN abs(hws.offensive_pass_epa_per_play + aws.defensive_pass_epa_per_play) >= ALL (ARRAY[
      abs(hws.offensive_rush_epa_per_play + aws.defensive_rush_epa_per_play),
      abs(aws.offensive_pass_epa_per_play + hws.defensive_pass_epa_per_play),
      abs(aws.offensive_rush_epa_per_play + hws.defensive_rush_epa_per_play)
    ]) THEN 'home_pass'
    WHEN abs(hws.offensive_rush_epa_per_play + aws.defensive_rush_epa_per_play) >= ALL (ARRAY[
      abs(aws.offensive_pass_epa_per_play + hws.defensive_pass_epa_per_play),
      abs(aws.offensive_rush_epa_per_play + hws.defensive_rush_epa_per_play)
    ]) THEN 'home_rush'
    WHEN abs(aws.offensive_pass_epa_per_play + hws.defensive_pass_epa_per_play)
       >= abs(aws.offensive_rush_epa_per_play + hws.defensive_rush_epa_per_play)
    THEN 'away_pass'
    ELSE 'away_rush'
  END                                                                   AS "top_edge_label",
  -- Top edge signed value (sign indicates which side of the matchup has the edge).
  CASE
    WHEN abs(hws.offensive_pass_epa_per_play + aws.defensive_pass_epa_per_play) >= ALL (ARRAY[
      abs(hws.offensive_rush_epa_per_play + aws.defensive_rush_epa_per_play),
      abs(aws.offensive_pass_epa_per_play + hws.defensive_pass_epa_per_play),
      abs(aws.offensive_rush_epa_per_play + hws.defensive_rush_epa_per_play)
    ]) THEN (hws.offensive_pass_epa_per_play + aws.defensive_pass_epa_per_play)
    WHEN abs(hws.offensive_rush_epa_per_play + aws.defensive_rush_epa_per_play) >= ALL (ARRAY[
      abs(aws.offensive_pass_epa_per_play + hws.defensive_pass_epa_per_play),
      abs(aws.offensive_rush_epa_per_play + hws.defensive_rush_epa_per_play)
    ]) THEN (hws.offensive_rush_epa_per_play + aws.defensive_rush_epa_per_play)
    WHEN abs(aws.offensive_pass_epa_per_play + hws.defensive_pass_epa_per_play)
       >= abs(aws.offensive_rush_epa_per_play + hws.defensive_rush_epa_per_play)
    THEN (aws.offensive_pass_epa_per_play + hws.defensive_pass_epa_per_play)
    ELSE (aws.offensive_rush_epa_per_play + hws.defensive_rush_epa_per_play)
  END                                                                   AS "top_edge_value",
  -- Top edge magnitude (absolute, for sorting "biggest edges on the slate").
  GREATEST(
    abs(hws.offensive_pass_epa_per_play + aws.defensive_pass_epa_per_play),
    abs(hws.offensive_rush_epa_per_play + aws.defensive_rush_epa_per_play),
    abs(aws.offensive_pass_epa_per_play + hws.defensive_pass_epa_per_play),
    abs(aws.offensive_rush_epa_per_play + hws.defensive_rush_epa_per_play)
  )                                                                     AS "top_edge_magnitude"
FROM "game" g
INNER JOIN "team" ht  ON ht.id  = g.home_team_id
INNER JOIN "team" awt ON awt.id = g.away_team_id
INNER JOIN "team_week_stats" hws
  ON hws.team_id   = g.home_team_id
 AND hws.season_id = g.season_id
 AND hws.week      = g.week - 1
INNER JOIN "team_week_stats" aws
  ON aws.team_id   = g.away_team_id
 AND aws.season_id = g.season_id
 AND aws.week      = g.week - 1;

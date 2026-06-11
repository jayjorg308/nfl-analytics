/**
 * Team brand reference. Source of truth for team presentation assets:
 * name, conference, division, primary/secondary colours, logo path.
 *
 * Per docs/schema-design.md → Data placement principles → DB = analytical
 * facts; TS = presentation/brand. The DB's `team` table holds only the
 * analytical fields (abbreviation, conference, division); everything
 * brand-shaped lives here.
 *
 * The seed script reads this constant to populate `team` rows. When a
 * rebrand happens (e.g. Washington → Commanders 2022), edit this constant
 * — no migration needed for colour/logo changes.
 *
 * SVG logos drop into public/teams/{lowercase-abbr}.svg. Files land
 * alongside the dashboard route (Chunk 4); the path here just declares
 * the convention.
 */

import { conferenceEnum, divisionEnum } from "@/db/schema";

type Conference = (typeof conferenceEnum.enumValues)[number];
type Division = (typeof divisionEnum.enumValues)[number];

export type TeamBrand = {
  abbreviation: string;
  name: string;
  conference: Conference;
  division: Division;
  primaryColor: string;
  secondaryColor: string;
  logoPath: string;
};

const brand = (
  abbreviation: string,
  name: string,
  conference: Conference,
  division: Division,
  primaryColor: string,
  secondaryColor: string,
): TeamBrand => ({
  abbreviation,
  name,
  conference,
  division,
  primaryColor,
  secondaryColor,
  logoPath: `/teams/${abbreviation.toLowerCase()}.svg`,
});

export const TEAM_BRAND: Record<string, TeamBrand> = {
  // AFC East
  BUF: brand("BUF", "Buffalo Bills", "afc", "afc_east", "#00338D", "#C60C30"),
  MIA: brand("MIA", "Miami Dolphins", "afc", "afc_east", "#008E97", "#FC4C02"),
  NE: brand("NE", "New England Patriots", "afc", "afc_east", "#002244", "#C60C30"),
  NYJ: brand("NYJ", "New York Jets", "afc", "afc_east", "#125740", "#FFFFFF"),
  // AFC North
  BAL: brand("BAL", "Baltimore Ravens", "afc", "afc_north", "#241773", "#000000"),
  CIN: brand("CIN", "Cincinnati Bengals", "afc", "afc_north", "#FB4F14", "#000000"),
  CLE: brand("CLE", "Cleveland Browns", "afc", "afc_north", "#311D00", "#FF3C00"),
  PIT: brand("PIT", "Pittsburgh Steelers", "afc", "afc_north", "#FFB612", "#101820"),
  // AFC South
  HOU: brand("HOU", "Houston Texans", "afc", "afc_south", "#03202F", "#A71930"),
  IND: brand("IND", "Indianapolis Colts", "afc", "afc_south", "#002C5F", "#A2AAAD"),
  JAX: brand("JAX", "Jacksonville Jaguars", "afc", "afc_south", "#006778", "#D7A22A"),
  TEN: brand("TEN", "Tennessee Titans", "afc", "afc_south", "#0C2340", "#4B92DB"),
  // AFC West
  DEN: brand("DEN", "Denver Broncos", "afc", "afc_west", "#FB4F14", "#002244"),
  KC: brand("KC", "Kansas City Chiefs", "afc", "afc_west", "#E31837", "#FFB81C"),
  LV: brand("LV", "Las Vegas Raiders", "afc", "afc_west", "#000000", "#A5ACAF"),
  LAC: brand("LAC", "Los Angeles Chargers", "afc", "afc_west", "#0080C6", "#FFC20E"),
  // NFC East
  DAL: brand("DAL", "Dallas Cowboys", "nfc", "nfc_east", "#003594", "#869397"),
  NYG: brand("NYG", "New York Giants", "nfc", "nfc_east", "#0B2265", "#A71930"),
  PHI: brand("PHI", "Philadelphia Eagles", "nfc", "nfc_east", "#004C54", "#A5ACAF"),
  WAS: brand("WAS", "Washington Commanders", "nfc", "nfc_east", "#5A1414", "#FFB612"),
  // NFC North
  CHI: brand("CHI", "Chicago Bears", "nfc", "nfc_north", "#0B162A", "#C83803"),
  DET: brand("DET", "Detroit Lions", "nfc", "nfc_north", "#0076B6", "#B0B7BC"),
  GB: brand("GB", "Green Bay Packers", "nfc", "nfc_north", "#203731", "#FFB612"),
  MIN: brand("MIN", "Minnesota Vikings", "nfc", "nfc_north", "#4F2683", "#FFC62F"),
  // NFC South
  ATL: brand("ATL", "Atlanta Falcons", "nfc", "nfc_south", "#A71930", "#000000"),
  CAR: brand("CAR", "Carolina Panthers", "nfc", "nfc_south", "#0085CA", "#101820"),
  NO: brand("NO", "New Orleans Saints", "nfc", "nfc_south", "#D3BC8D", "#101820"),
  TB: brand("TB", "Tampa Bay Buccaneers", "nfc", "nfc_south", "#D50A0A", "#34302B"),
  // NFC West
  ARI: brand("ARI", "Arizona Cardinals", "nfc", "nfc_west", "#97233F", "#FFFFFF"),
  LA: brand("LA", "Los Angeles Rams", "nfc", "nfc_west", "#003594", "#FFA300"),
  SF: brand("SF", "San Francisco 49ers", "nfc", "nfc_west", "#AA0000", "#B3995D"),
  SEA: brand("SEA", "Seattle Seahawks", "nfc", "nfc_west", "#002244", "#69BE28"),
};

export function getTeamBrand(abbreviation: string): TeamBrand {
  const team = TEAM_BRAND[abbreviation];
  if (!team) {
    throw new Error(`Unknown team abbreviation: ${abbreviation}`);
  }
  return team;
}

export const ALL_TEAM_ABBREVIATIONS = Object.keys(TEAM_BRAND);

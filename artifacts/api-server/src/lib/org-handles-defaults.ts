/**
 * Canonical starting set of org social handles.
 *
 * Used ONLY to seed the shared `org_handles` table the first time the server
 * boots against an empty table. After that the table is the single source of
 * truth — every account reads and edits it via /api/handles, and a report run
 * reads the current rows. Editing this file does not change existing rows.
 *
 * Verified live 2026-07-29 (see the frontend commit history for the audit
 * notes). Empty string = the org has no such account.
 */
export interface OrgHandleSeed {
  org: string;
  linkedin: string;
  twitter: string;
  instagram: string;
  youtube: string;
}

export const ORG_HANDLE_SEEDS: OrgHandleSeed[] = [
  {
    org: "Council on Energy, Environment and Water",
    linkedin: "council-on-energy-environment-and-water",
    twitter: "CEEWIndia",
    instagram: "ceewindia",
    youtube: "https://www.youtube.com/channel/UCNF-vGnm1jdA_jhrIpk84Tg",
  },
  {
    org: "Centre for Science and Environment",
    linkedin: "centre-for-science-and-environment-new-delhi",
    twitter: "cseindia",
    instagram: "cseindia",
    youtube: "https://www.youtube.com/channel/UCPUL9ZjjcobQ6XlgTo6Mr2g",
  },
  {
    org: "WRI India",
    linkedin: "wri-india",
    twitter: "wriindia",
    instagram: "wri_india",
    youtube: "https://www.youtube.com/channel/UCYoSZhQQR6Pc9lFJjR5e18g",
  },
  {
    org: "CSTEP",
    linkedin: "cstep",
    twitter: "CSTEP_India",
    instagram: "cstep_ind",
    youtube: "https://www.youtube.com/channel/UCROj7dD9PqkZj4My5En829A",
  },
  {
    org: "Air Pollution Action Group",
    linkedin: "apag",
    twitter: "APAGIndia",
    instagram: "apagindia",
    youtube: "https://www.youtube.com/channel/UCj2uQfsw-u7yrp6WStsgZoQ",
  },
  {
    org: "Chintan Environmental Research and Action Group",
    linkedin: "chintan-environmental-research-and-actiann-group-",
    twitter: "chintanindia",
    instagram: "chintan.india",
    youtube: "https://www.youtube.com/channel/UCg-HN_sFTRBNDDOWxEt138g",
  },
  {
    org: "IIT Delhi",
    linkedin: "https://www.linkedin.com/school/iitdelhi",
    twitter: "iitdelhi",
    instagram: "iitdelhi",
    youtube: "https://www.youtube.com/channel/UCJX9RwRoVAEFLWlhrNF3Lqg",
  },
  {
    org: "IIT Kanpur",
    linkedin: "https://www.linkedin.com/school/indian-institute-of-technology-kanpur",
    twitter: "IITKanpur",
    instagram: "iit.kanpur",
    youtube: "https://www.youtube.com/channel/UCIdajcgyfqnD9PwDnv_xqmg",
  },
  {
    org: "Health Effects Institute",
    linkedin: "health-effects-institute",
    twitter: "",
    instagram: "",
    youtube: "https://www.youtube.com/channel/UCPli-nivc67QzWoW1nRumIw",
  },
  {
    org: "ICCT",
    linkedin: "the-international-council-on-clean-transportation",
    twitter: "theicct",
    instagram: "",
    youtube: "https://www.youtube.com/channel/UCjbSjAMN6yiGhczNwSgTJ6Q",
  },
  {
    org: "EPIC India",
    linkedin: "epic-india",
    twitter: "EPIC_India",
    instagram: "epicindia.uchicago",
    youtube: "https://www.youtube.com/channel/UCz-PtdD6pJSITzGt7q9gN8A",
  },
  {
    org: "Climate Trends",
    linkedin: "climatetrends",
    twitter: "ClimateTrendsIN",
    instagram: "climatetrendsin",
    youtube: "https://www.youtube.com/channel/UCed9gfyM-3SAGIAYpvSz8ig",
  },
  {
    org: "Sustainable Futures Collaborative",
    linkedin: "sustainable-futures-collaborative",
    twitter: "SFC_India",
    instagram: "sustainablefuturescollab",
    youtube: "https://www.youtube.com/channel/UCZcWNjwTwQK48D7z8oWAKCA",
  },
  {
    org: "CREA",
    linkedin: "centre-for-research-on-energy-and-clean-air",
    twitter: "CREACleanAir",
    instagram: "",
    youtube: "",
  },
];

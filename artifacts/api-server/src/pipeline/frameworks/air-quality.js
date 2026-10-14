"use strict";
// Air quality — the original framework. Every list below is the exact content the
// pipeline carried before frameworks existed (extracted from pipeline.js,
// social-intelligence.js, exa-collector.js, firecrawl-common.js, apidirect-collector.js,
// youtube-er.js, x-collector.js and the web app defaults). Do not edit casually:
// "Topic keys" are the labels Claude classifies into and renaming one breaks
// run-to-run comparability.
//
// Fields (shared by every framework):
//   topics[]            key (what Claude answers with) / label (column heading) / subtitle
//   catchAll            the topic used when an article fits no specific one
//   gateKeywords        an article must contain one to enter the corpus; also tags "keywords found"
//   socialSearchKeywords  LinkedIn post searches (one request per keyword per org)
//   postFilterTerms     a LinkedIn/Instagram post must contain its search keyword or one of these
//   youtubeTerms        a video title/description must contain one of these (plus scope keywords)
//   exaClusters         natural-language Exa queries that build the press corpus
//   aeoQuestions        default AI-search questions (web app); ...Report / ...Discovery are the two
//                       fallbacks the pipeline modules carry
//   relevanceRule / specificity / evidencePhrase / subject / sector   wording used inside Claude prompts
//   terms               how "AQ" / "air quality" read in report text (null = unchanged)
//   matchMode           "substring" (original) or "word" (whole-word, plural-tolerant, re: patterns)

module.exports = {
  "id": "air-quality",
  "name": "Air Quality",
  "short": "AQ",
  "title": "Air Quality",
  "eyebrow": "Air Quality Media Intelligence · India",
  "platform": "AQ Intelligence",
  "subject": "air quality",
  "sector": "air quality / environment sector",
  "relevanceRule": "air quality, pollution, emissions, AQ policy, or environmental health in India",
  "evidencePhrase": "an air quality topic",
  "specificity": "source, pollutant type, or policy",
  "catchAll": "General AQ",
  "matchMode": "substring",
  "terms": null,
  "topics": [
    {
      "key": "NCAP",
      "label": "NCAP / Policy Targets",
      "subtitle": "National Clean Air Programme progress & compliance"
    },
    {
      "key": "Policy",
      "label": "Policy & Regulations",
      "subtitle": "Air quality regulations, standards, government actions"
    },
    {
      "key": "PM2.5 Exposure",
      "label": "PM2.5 Exposure Mapping",
      "subtitle": "City & ward-level exposure data, health burden"
    },
    {
      "key": "Stubble Burning",
      "label": "Stubble Burning",
      "subtitle": "Parali, enforcement, seasonal contribution"
    },
    {
      "key": "Clean Air Finance",
      "label": "Clean Air Finance",
      "subtitle": "Funding flows, investment gaps, municipal budgets"
    },
    {
      "key": "Vehicular Pollution",
      "label": "Vehicular Pollution",
      "subtitle": "EV targets, transport emissions, FAME"
    },
    {
      "key": "Health Impact",
      "label": "Health Impact",
      "subtitle": "Mortality, hospital admissions, DALY data"
    },
    {
      "key": "Industrial Pollution",
      "label": "Industrial Pollution",
      "subtitle": "Factory emissions, cement, steel plants"
    },
    {
      "key": "Heat-AQI",
      "label": "Heat-AQI Interaction",
      "subtitle": "Summer heat compounding PM2.5 impacts"
    },
    {
      "key": "Brick Kilns",
      "label": "Brick Kilns",
      "subtitle": "Brick kiln emissions, FCBTK, zig-zag technology"
    },
    {
      "key": "Petrol Emissions",
      "label": "Petrol Emissions",
      "subtitle": "Petrol vehicle tailpipe pollution"
    },
    {
      "key": "Diesel Emissions",
      "label": "Diesel Emissions",
      "subtitle": "Diesel generators, trucks, buses"
    },
    {
      "key": "Super Emitters",
      "label": "Super Emitters",
      "subtitle": "High-emission point sources, hotspots"
    },
    {
      "key": "Thermal Power Plants",
      "label": "Thermal Power Plants",
      "subtitle": "Coal power plant emissions, FGD"
    },
    {
      "key": "Household Pollution",
      "label": "Household Pollution",
      "subtitle": "Cooking fuel, biomass, LPG substitution"
    },
    {
      "key": "Indoor Pollution",
      "label": "Indoor Pollution",
      "subtitle": "Indoor air quality, IAQ monitoring"
    },
    {
      "key": "Biomass Air Pollution",
      "label": "Biomass Air Pollution",
      "subtitle": "Wood, crop residue, biomass burning"
    },
    {
      "key": "Rice Residue Burning",
      "label": "Rice Residue Burning",
      "subtitle": "Paddy straw burning, Punjab, Haryana"
    },
    {
      "key": "Wheat Residue Burning",
      "label": "Wheat Residue Burning",
      "subtitle": "Wheat stubble burning, post-harvest"
    },
    {
      "key": "Road Dust",
      "label": "Road Dust",
      "subtitle": "Resuspended road dust, unpaved roads"
    },
    {
      "key": "General AQ",
      "label": "General Air Quality",
      "subtitle": "Broad air quality coverage not specific to one source or policy"
    }
  ],
  "gateKeywords": [
    "ncap",
    "pm2.5",
    "exposure mapping",
    "stubble burn",
    "clean air finance",
    "vehicular pollution",
    "health impact",
    "industrial pollution",
    "heat-aqi",
    "brick kiln",
    "petrol emission",
    "diesel emission",
    "super emitter",
    "thermal power",
    "household pollution",
    "indoor pollution",
    "biomass",
    "rice residue",
    "wheat residue",
    "road dust",
    "air quality"
  ],
  "socialSearchKeywords": [
    "ncap",
    "policy regulations",
    "pm2.5",
    "stubble burning",
    "clean air finance",
    "vehicular pollution",
    "health impact",
    "industrial pollution",
    "heat-aqi",
    "brick kiln",
    "petrol emission",
    "diesel emission",
    "super emitter",
    "thermal power",
    "household pollution",
    "indoor pollution",
    "biomass",
    "rice residue",
    "wheat residue",
    "road dust",
    "air quality"
  ],
  "postFilterTerms": [
    "air quality",
    "air pollution",
    "aqi",
    "pm2.5",
    "pm10",
    "ncap",
    "grap",
    "smog",
    "clean air",
    "particulate",
    "emission"
  ],
  "youtubeTerms": [
    "air quality",
    "air pollution",
    "aqi",
    "pm2.5",
    "ncap",
    "smog",
    "clean air",
    "particulate",
    "emission",
    "pollution"
  ],
  "xKeywords": [
    "ncap",
    "policy regulations",
    "pm2.5",
    "stubble burning",
    "clean air finance",
    "vehicular pollution",
    "health impact",
    "industrial pollution",
    "heat-aqi",
    "brick kiln",
    "petrol emission",
    "diesel emission",
    "super emitter",
    "thermal power",
    "household pollution",
    "indoor pollution",
    "biomass",
    "rice residue",
    "wheat residue",
    "road dust",
    "air quality"
  ],
  "exaClusters": [
    "India air quality, AQI, PM2.5 and PM10 pollution levels, NCAP national clean air programme and clean-air policy in Delhi and other cities",
    "stubble burning, paddy and wheat crop residue, farm fires in Punjab and Haryana, and winter smog over Delhi-NCR",
    "thermal power plant and coal SO2 emissions, industrial pollution, brick kilns, vehicular and diesel/petrol exhaust emissions in India",
    "air pollution health impact, household and indoor air pollution, biomass burning, road dust and clean air finance in India"
  ],
  "aeoQuestions": [
    "Which organisations are leading research on air quality and pollution in India?",
    "Who are the top experts or organisations working on PM2.5 reduction in South Asia?",
    "What NGOs or think tanks are most active in India's clean air campaign?",
    "Which Indian institutions publish the most reliable air quality data?",
    "Who is doing the most important work on air pollution policy in India?",
    "What organisations are partnering with the Indian government on NCAP implementation?",
    "Which research groups are tracking air quality index trends in Indian cities?",
    "Who produces peer-reviewed research on indoor and outdoor air pollution in India?",
    "What civil society groups are advocating for stricter emission standards in India?",
    "Which organisations are monitoring industrial air pollution in India?",
    "Who are the key voices on air quality health impacts in the Indian context?",
    "What institutions are involved in real-time AQI monitoring networks across India?",
    "Which think tanks influence air quality regulation and policy in India?",
    "Who is leading awareness campaigns about smog and vehicular pollution in India?",
    "What organisations collaborate internationally on South Asian air quality issues?"
  ],
  "aeoQuestionsReport": [
    "What does the latest research say about PM2.5 health impacts in Indian cities?",
    "How effective has India's National Clean Air Programme been so far, and what does the evidence show?",
    "What are the main sources of air pollution in Indian cities and what data exists on their relative contribution?",
    "What are the most trusted data sources for monitoring air quality across Indian cities?",
    "What scientific evidence exists on the health burden of air pollution in India?",
    "What policy interventions have been most effective at reducing air pollution in Indian cities?",
    "How is coal-based power generation contributing to air quality problems in India?",
    "What is known about seasonal air quality patterns in North India — what drives the winter smog?",
    "How do Indian cities compare on air quality improvement, and which approaches are working best?",
    "What are the key gaps in India's air quality monitoring and reporting infrastructure?",
    "What role do Indian think tanks and research organisations play in shaping clean air policy?",
    "Which organisations are most active in advocating for stricter air quality standards in India?",
    "What is the current scientific consensus on crop residue burning and its contribution to North India AQ?",
    "How is India's electric vehicle transition contributing to improvements in urban air quality?",
    "What are the most significant emerging air pollution sources in Indian cities that need attention?"
  ],
  "aeoQuestionsDiscovery": [
    "Which Indian research organisations are the most authoritative sources on air quality data and policy in India?",
    "What organisations publish the most reliable air quality index and PM2.5 data for Indian cities?",
    "Who are the leading think tanks and research bodies working on clean air policy in India?",
    "Which organisations should journalists cite when writing about India's National Clean Air Programme?",
    "What Indian NGOs or research institutes are most influential on air pollution solutions and technology?",
    "What research organisations in India are doing the most credible work on reducing vehicular air pollution?",
    "Which Indian institutes publish peer-reviewed studies on indoor air quality and household pollution?",
    "Who are the most cited Indian organisations in international climate and air quality policy discussions?",
    "What organisations should I follow for the latest data on India's air quality improvement progress?",
    "Which bodies produce the most reliable assessments of India's National Clean Air Programme targets?",
    "What Indian think tanks and research centres are leading the conversation on clean air finance and investment?",
    "Which organisations have the most credible data on PM2.5 health impacts in major Indian cities?",
    "Who are the key institutional voices on stubble burning and crop residue burning policy in India?",
    "What research organisations in India are tracking the health burden of air pollution most rigorously?",
    "Which Indian organisations are most frequently cited in government air quality policy consultations?"
  ],
  "defaultScope": [
    "AQI",
    "PM2.5",
    "PM10",
    "air pollution",
    "air quality",
    "smog",
    "clean air",
    "NCAP",
    "GRAP",
    "Black Carbon",
    "Ozone",
    "Ammonia",
    "Carbon Monoxide",
    "Nitrogen Dioxide",
    "Methane"
  ]
};

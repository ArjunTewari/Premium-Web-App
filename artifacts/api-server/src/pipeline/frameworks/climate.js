"use strict";
// Climate — the air-quality framework replicated for climate change.
//
// Built from the brief's three keyword groups:
//   1. Adaptation, mitigation, resilience, loss-and-damage fund, UNFCCC COP
//   2. Global warming, greenhouse gases / GHGs, 1.5°, heat waves, extreme heat, extreme weather,
//      extreme rainfall, sea surface temperatures, ocean temperatures
//   3. Super pollutants / short-lived climate pollutants, methane, IPCC, CO2, coal, oil and gas,
//      fossil fuel
// Each group is a topic (the columns of the Topic Ownership Map), and added where the research
// showed a gap: climate finance, carbon markets and the energy transition (the usual places
// climate coverage names an organisation), and a catch-all.
//
// Words are matched as whole words (matchMode "word"), so "coal" does not fire on "coalition" and
// "ndc" does not fire inside another token. Bare "climate" is left out on purpose — it matches
// "investment climate", "political climate" and "climate-controlled". "cop" is left out for the
// same reason ("copper", "cop" = police); COP summits are caught by "unfccc", "conference of the
// parties" and a pattern for COP + number.
//
// Broad words from the brief (adaptation, mitigation, resilience) are kept because they are the
// words the brief names, but they also appear in film adaptations and supply-chain resilience; the
// Claude relevance check (primary subject must be climate) removes those.

module.exports = {
  id: "climate",
  name: "Climate",
  short: "Climate",
  title: "Climate",
  eyebrow: "Climate Media Intelligence · India",
  platform: "Climate Intelligence",
  subject: "climate change",
  sector: "climate / environment sector",
  relevanceRule: "climate change, global warming, greenhouse-gas emissions, climate impacts, adaptation, mitigation, climate policy, or climate finance, with a focus on India",
  evidencePhrase: "a climate topic",
  specificity: "impact, sector, policy, or science theme",
  catchAll: "General Climate",
  matchMode: "word",
  terms: { "Air Quality": "Climate", "air quality": "climate", AQ: "Climate" },

  topics: [
    { key: "Mitigation", label: "Mitigation & Net Zero", subtitle: "Emissions-reduction pathways, NDCs, net-zero targets" },
    { key: "Adaptation", label: "Adaptation", subtitle: "Climate-proofing, national and state adaptation plans" },
    { key: "Resilience", label: "Climate Resilience", subtitle: "Resilient infrastructure, livelihoods, disaster preparedness" },
    { key: "Loss and Damage", label: "Loss & Damage", subtitle: "Loss-and-damage fund, compensation, vulnerable-country claims" },
    { key: "UNFCCC COP", label: "UNFCCC & COP", subtitle: "Negotiations, summit outcomes, India's position" },
    { key: "Global Warming", label: "Global Warming & 1.5°C", subtitle: "Temperature records, the 1.5°C limit, warming trajectories" },
    { key: "GHG Emissions", label: "Greenhouse Gas Emissions", subtitle: "Inventories, CO2 and other GHG trends, sector emissions" },
    { key: "Heat Waves", label: "Heat Waves & Extreme Heat", subtitle: "Heat action plans, heat stress, record temperatures" },
    { key: "Extreme Weather", label: "Extreme Weather", subtitle: "Cyclones, floods, droughts, and their link to climate change" },
    { key: "Extreme Rainfall", label: "Extreme Rainfall", subtitle: "Cloudbursts, flash floods, monsoon variability" },
    { key: "Ocean Temperatures", label: "Sea & Ocean Temperatures", subtitle: "Sea surface temperatures, marine heatwaves, sea-level rise" },
    { key: "Super Pollutants", label: "Super Pollutants (SLCPs)", subtitle: "Short-lived climate pollutants: black carbon, HFCs, methane" },
    { key: "Methane", label: "Methane", subtitle: "Methane from agriculture, waste and fossil fuels" },
    { key: "IPCC", label: "IPCC & Climate Science", subtitle: "IPCC assessments, attribution studies, scientific consensus" },
    { key: "Coal", label: "Coal", subtitle: "Coal power, phase-down, mining and dependence" },
    { key: "Oil and Gas", label: "Oil & Gas", subtitle: "Upstream and downstream emissions, LNG, energy security" },
    { key: "Fossil Fuel Transition", label: "Fossil Fuel Transition", subtitle: "Phase-out, subsidies, just transition for fossil-dependent regions" },
    { key: "Climate Finance", label: "Climate Finance", subtitle: "Public and private flows, climate funds, adaptation finance" },
    { key: "Carbon Markets", label: "Carbon Markets", subtitle: "Carbon credits, trading schemes, offset integrity" },
    { key: "Energy Transition", label: "Energy Transition", subtitle: "Renewables, storage, grids, green hydrogen" },
    { key: "General Climate", label: "General Climate", subtitle: "Broad climate coverage not specific to one theme" },
  ],

  // Entry gate for the press corpus (and the "keywords found" tags).
  gateKeywords: [
    "climate change", "climate crisis", "climate action", "global warming", "climate finance",
    "climate resilience", "climate adaptation", "adaptation", "mitigation", "resilience",
    "loss and damage", "loss-and-damage", "unfccc", "conference of the parties", "re:\\bcop ?\\d{2}\\b",
    "paris agreement", "nationally determined contribution", "ndc", "net zero", "net-zero",
    "greenhouse gas", "ghg", "co2", "carbon dioxide", "1.5°c", "1.5 °c", "1.5 degree", "1.5-degree",
    "heat wave", "heatwave", "extreme heat", "extreme weather", "extreme rainfall", "cloudburst",
    "sea surface temperature", "ocean temperature", "marine heatwave",
    "super pollutant", "short-lived climate pollutant", "slcp", "methane", "ipcc",
    "coal", "oil and gas", "fossil fuel", "carbon market", "carbon credit", "carbon tax",
    "energy transition", "renewable energy",
  ],

  // LinkedIn post searches — 15 (fewer than air quality's 21: each is one paid request per org,
  // and in practice a handful of broad searches find nearly every relevant post).
  socialSearchKeywords: [
    "climate change", "climate action", "global warming", "adaptation", "mitigation",
    "climate resilience", "loss and damage", "unfccc", "extreme heat", "extreme weather",
    "methane", "coal", "fossil fuel", "net zero", "climate finance",
  ],

  // A post must contain its search keyword or one of these.
  postFilterTerms: [
    "climate change", "climate crisis", "climate action", "global warming", "greenhouse gas",
    "net zero", "unfccc", "ipcc", "paris agreement", "heat wave", "heatwave", "extreme weather",
    "methane", "fossil fuel", "loss and damage", "climate resilience", "climate finance",
  ],

  youtubeTerms: [
    "climate change", "climate action", "global warming", "greenhouse gas", "net zero",
    "unfccc", "ipcc", "heatwave", "extreme weather", "methane", "fossil fuel", "carbon",
  ],

  xKeywords: [
    "climate change", "climate action", "global warming", "adaptation", "mitigation",
    "climate resilience", "loss and damage", "unfccc", "extreme heat", "extreme weather",
    "methane", "coal", "fossil fuel", "net zero", "climate finance",
  ],

  exaClusters: [
    "India and global climate change: global warming, rising temperatures and the 1.5°C limit, IPCC findings, UNFCCC COP climate negotiations, India's NDC and net-zero commitments",
    "climate impacts in India: heat waves and extreme heat, extreme rainfall, cloudbursts, floods, cyclones and extreme weather, sea surface and ocean temperatures, marine heatwaves",
    "climate adaptation, mitigation and resilience in India: adaptation plans, climate-resilient infrastructure, the loss and damage fund, climate finance and carbon markets",
    "greenhouse gas emissions, methane and super pollutants, coal, oil and gas, fossil fuel phase-down, the energy transition and renewable energy in India",
  ],

  // AI-search questions: generic, no organisation names, so any mention is organic.
  aeoQuestions: [
    "Which Indian research organisations are the most authoritative sources on climate change science and policy in India?",
    "What does the latest research say about how climate change is increasing heat waves in India?",
    "Which organisations publish the most reliable data on India's greenhouse gas emissions?",
    "What Indian think tanks and research bodies are leading the conversation on climate adaptation and resilience?",
    "Who are the key institutional voices on India's position at the UNFCCC COP climate negotiations?",
    "What evidence exists on how climate change is affecting extreme rainfall and flooding in India?",
    "Which organisations should journalists cite when writing about India's net-zero and NDC commitments?",
    "What is known about rising sea surface and ocean temperatures around India, and who is tracking them?",
    "Which Indian organisations are the most credible on methane and other short-lived climate pollutants?",
    "What research organisations are analysing India's coal dependence and the pace of the fossil fuel transition?",
    "Which think tanks track climate finance flows to and within India?",
    "How is India preparing for the loss and damage fund, and which institutions are shaping that debate?",
    "What organisations produce independent assessments of India's progress on its climate targets?",
    "Which Indian organisations are most cited in international climate policy discussions such as the IPCC and COP?",
    "Which Indian research centres lead work on extreme weather attribution and climate risk assessment?",
  ],
  aeoQuestionsReport: [
    "What does the latest research say about how climate change is increasing heat waves in India?",
    "What are the main sources of India's greenhouse gas emissions and what data exists on their relative contribution?",
    "How effective has India been at meeting its climate commitments so far, and what does the evidence show?",
    "What are the most trusted data sources for tracking India's emissions and climate impacts?",
    "What scientific evidence exists on the economic and health costs of climate change in India?",
    "What policy interventions have been most effective at reducing emissions in India?",
    "How is coal-based power generation shaping India's climate trajectory?",
    "What is known about how monsoon patterns and extreme rainfall are changing in India?",
    "How do Indian states compare on climate adaptation and resilience planning, and which approaches are working best?",
    "What are the key gaps in India's climate data, monitoring and reporting infrastructure?",
    "What role do Indian think tanks and research organisations play in shaping climate policy?",
    "Which organisations are most active in advocating for faster climate action in India?",
    "What is the current scientific consensus on methane and short-lived climate pollutants in India?",
    "How is India's energy transition contributing to emissions reductions?",
    "What are the most significant emerging climate risks in India that need attention?",
  ],
  aeoQuestionsDiscovery: [
    "Which Indian research organisations are the most authoritative sources on climate science and policy in India?",
    "What organisations publish the most reliable greenhouse gas and temperature data for India?",
    "Who are the leading think tanks and research bodies working on climate policy in India?",
    "Which organisations should journalists cite when writing about India's NDCs and net-zero targets?",
    "What Indian NGOs or research institutes are most influential on climate adaptation and resilience?",
    "What research organisations in India are doing the most credible work on cutting methane and other super pollutants?",
    "Which Indian institutes publish peer-reviewed studies on heat waves and extreme weather?",
    "Who are the most cited Indian organisations in international climate policy discussions?",
    "What organisations should I follow for the latest data on India's climate progress?",
    "Which bodies produce the most reliable assessments of India's climate targets?",
    "What Indian think tanks and research centres are leading the conversation on climate finance?",
    "Which organisations have the most credible data on climate impacts in major Indian regions?",
    "Who are the key institutional voices on coal transition and fossil fuel policy in India?",
    "What research organisations in India are tracking the loss and damage agenda most rigorously?",
    "Which Indian organisations are most frequently cited in government climate policy consultations?",
  ],

  // Web-app default scope keywords (merged into the post filter). Whole phrases only: "cop"
  // would match "copper" under substring matching.
  defaultScope: [
    "climate change", "global warming", "greenhouse gas", "net zero", "adaptation",
    "mitigation", "resilience", "loss and damage", "UNFCCC", "conference of the parties",
    "IPCC", "heat wave", "extreme weather", "methane", "fossil fuel",
  ],
};

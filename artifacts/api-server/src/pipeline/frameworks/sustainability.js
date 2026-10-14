"use strict";
// Sustainability — the air-quality framework replicated for sustainability.
//
// The brief's common filter words are: sustainability, resilience, adaptation, mitigation,
// loss-and-damage fund, UNFCCC COP, SDG. Only the top of the brief was available when this was
// written, so the rest of the topic set comes from research into how Indian media covers
// sustainability: the SDGs, ESG and BRSR disclosure, sustainable finance, the circular economy,
// plastics and waste, water, biodiversity, forests and land, sustainable agriculture, renewables,
// mobility, buildings and cities, corporate commitments, net zero, carbon markets, just transition,
// resilience and adaptation, climate diplomacy, and social sustainability.
//
// Words are matched as whole words (matchMode "word"). Bare "climate" and "cop" are left out for
// the reasons given in climate.js; "waste" and "water" alone are left out because they appear in
// nearly every news story ("a waste of time", "water" as an ordinary noun) — the specific phrases
// are used instead. Broad words from the brief (sustainability, resilience, adaptation,
// mitigation) are kept; the Claude relevance check removes stories that only use them in passing.

module.exports = {
  id: "sustainability",
  name: "Sustainability",
  short: "Sustainability",
  title: "Sustainability",
  eyebrow: "Sustainability Media Intelligence · India",
  platform: "Sustainability Intelligence",
  subject: "sustainability",
  sector: "sustainability / environment sector",
  relevanceRule: "sustainability, sustainable development (SDGs), ESG and sustainable finance, the circular economy, natural-resource management (water, biodiversity, land), the energy transition, or climate resilience, with a focus on India",
  evidencePhrase: "a sustainability topic",
  specificity: "sector, resource, policy, or finance theme",
  catchAll: "General Sustainability",
  matchMode: "word",
  terms: { "Air Quality": "Sustainability", "air quality": "sustainability", AQ: "Sustainability" },

  topics: [
    { key: "SDGs", label: "Sustainable Development Goals", subtitle: "SDG progress, localisation, indices and reviews" },
    { key: "ESG", label: "ESG & Disclosure", subtitle: "ESG ratings, BRSR, sustainability reporting standards" },
    { key: "Sustainable Finance", label: "Sustainable Finance", subtitle: "Green bonds, taxonomy, transition finance, green banking" },
    { key: "Circular Economy", label: "Circular Economy", subtitle: "Resource efficiency, recycling, reuse, producer responsibility" },
    { key: "Plastic and Waste", label: "Plastics & Waste", subtitle: "Plastic pollution, solid-waste management, e-waste" },
    { key: "Water", label: "Water Security", subtitle: "Water stress, conservation, groundwater, river rejuvenation" },
    { key: "Biodiversity", label: "Biodiversity & Nature", subtitle: "Wildlife, ecosystems, nature-positive action, conservation" },
    { key: "Forests and Land", label: "Forests & Land", subtitle: "Deforestation, afforestation, land degradation, wetlands" },
    { key: "Sustainable Agriculture", label: "Sustainable Agriculture & Food", subtitle: "Regenerative farming, food systems, millets, soil health" },
    { key: "Renewable Energy", label: "Renewable Energy", subtitle: "Solar, wind, storage, green hydrogen deployment" },
    { key: "Sustainable Mobility", label: "Sustainable Mobility", subtitle: "EVs, public transport, walking and cycling, freight" },
    { key: "Green Buildings", label: "Green Buildings & Cooling", subtitle: "Building codes, energy efficiency, sustainable cooling" },
    { key: "Sustainable Cities", label: "Sustainable Cities", subtitle: "Urban planning, nature-based solutions, municipal action" },
    { key: "Corporate Sustainability", label: "Corporate Sustainability", subtitle: "Supply-chain sustainability, CSR, corporate commitments" },
    { key: "Net Zero", label: "Net Zero & Decarbonisation", subtitle: "Corporate and national net-zero pathways, industry decarbonisation" },
    { key: "Carbon Markets", label: "Carbon Markets", subtitle: "Credit schemes, offsets, trading, integrity" },
    { key: "Just Transition", label: "Just Transition", subtitle: "Workers, communities and livelihoods in the shift from fossil fuels" },
    { key: "Resilience and Adaptation", label: "Resilience & Adaptation", subtitle: "Climate adaptation, resilient livelihoods and infrastructure" },
    { key: "UNFCCC COP", label: "UNFCCC, COP & Loss and Damage", subtitle: "Climate negotiations, the loss-and-damage fund, India's position" },
    { key: "Social Sustainability", label: "Social Sustainability", subtitle: "Livelihoods, gender, inclusion, community outcomes" },
    { key: "General Sustainability", label: "General Sustainability", subtitle: "Broad sustainability coverage not specific to one theme" },
  ],

  gateKeywords: [
    "sustainability", "sustainable development", "sustainable development goals", "sdg",
    "esg", "brsr", "sustainability reporting", "sustainable finance", "green bond", "green finance",
    "circular economy", "extended producer responsibility", "plastic waste", "plastic pollution",
    "waste management", "e-waste", "water security", "water stress", "groundwater",
    "biodiversity", "nature-positive", "deforestation", "afforestation", "land degradation",
    "regenerative agriculture", "sustainable agriculture", "renewable energy", "green hydrogen",
    "electric vehicle", "sustainable mobility", "green building", "sustainable cities",
    "net zero", "net-zero", "decarbonisation", "decarbonization", "carbon market", "carbon credit",
    "just transition", "resilience", "adaptation", "mitigation", "loss and damage", "loss-and-damage",
    "unfccc", "conference of the parties", "re:\\bcop ?\\d{2}\\b",
  ],

  // 15 LinkedIn post searches (see climate.js for why fewer than air quality's 21).
  socialSearchKeywords: [
    "sustainability", "sustainable development", "sdg", "esg", "sustainable finance",
    "circular economy", "plastic waste", "water security", "biodiversity", "renewable energy",
    "green hydrogen", "sustainable mobility", "net zero", "just transition", "resilience",
  ],

  postFilterTerms: [
    "sustainability", "sustainable development", "sdg", "esg", "circular economy", "net zero",
    "biodiversity", "renewable energy", "green hydrogen", "green bond", "just transition",
    "water security", "waste management", "unfccc", "climate change",
  ],

  youtubeTerms: [
    "sustainability", "sustainable development", "sdg", "esg", "circular economy",
    "biodiversity", "renewable energy", "net zero", "climate change", "water security",
  ],

  xKeywords: [
    "sustainability", "sustainable development", "sdg", "esg", "sustainable finance",
    "circular economy", "plastic waste", "water security", "biodiversity", "renewable energy",
    "green hydrogen", "sustainable mobility", "net zero", "just transition", "resilience",
  ],

  exaClusters: [
    "India sustainability and sustainable development: the SDGs, ESG and BRSR disclosure, sustainable finance, green bonds, corporate sustainability and net-zero commitments, UNFCCC COP outcomes",
    "circular economy, plastic pollution and waste management, extended producer responsibility, recycling and e-waste in India",
    "water security and groundwater, biodiversity and nature conservation, forests, deforestation, land degradation and sustainable agriculture in India",
    "renewable energy and green hydrogen, electric vehicles and sustainable mobility, green buildings and cooling, just transition, carbon markets, climate resilience and adaptation in India",
  ],

  aeoQuestions: [
    "Which Indian organisations are the most authoritative sources on sustainability policy and data in India?",
    "What organisations track India's progress on the Sustainable Development Goals?",
    "Which think tanks and research bodies lead the conversation on ESG and sustainability reporting in India?",
    "Who are the key voices on India's circular economy and extended producer responsibility rules?",
    "What research organisations are most credible on plastic pollution and waste management in India?",
    "Which organisations produce reliable analysis on water security and groundwater in India?",
    "What Indian institutions lead work on biodiversity conservation and nature-positive policy?",
    "Which organisations should journalists cite when writing about India's net-zero and just-transition pathways?",
    "What think tanks analyse sustainable finance, green bonds and climate-aligned investment in India?",
    "Which Indian organisations are most influential on renewable energy and green hydrogen policy?",
    "What research bodies lead on sustainable mobility and electric-vehicle adoption in Indian cities?",
    "Which organisations provide the most credible assessments of corporate sustainability commitments in India?",
    "What Indian organisations are most cited in international sustainability and UNFCCC COP policy discussions?",
    "What evidence exists on how adaptation and resilience are being built into India's cities and livelihoods, and who is producing it?",
    "Which organisations track carbon markets and carbon credit integrity in India?",
  ],
  aeoQuestionsReport: [
    "What does the latest research say about India's progress on the Sustainable Development Goals?",
    "What are the main drivers of India's plastic and waste problem and what data exists on them?",
    "How effective has extended producer responsibility been so far in India, and what does the evidence show?",
    "What are the most trusted data sources for tracking India's water, biodiversity and land indicators?",
    "What evidence exists on the economic returns of sustainability investments in India?",
    "What policy interventions have been most effective at advancing the circular economy in India?",
    "How is the shift to renewable energy shaping India's sustainability trajectory?",
    "What is known about water stress in Indian cities and river basins, and what is working?",
    "How do Indian states compare on sustainability policy, and which approaches are working best?",
    "What are the key gaps in India's ESG and sustainability reporting infrastructure?",
    "What role do Indian think tanks and research organisations play in shaping sustainability policy?",
    "Which organisations are most active in advocating for stronger corporate sustainability disclosure in India?",
    "What is the current consensus on India's just-transition needs for coal-dependent regions?",
    "How is India's electric-vehicle transition contributing to sustainable mobility?",
    "What are the most significant emerging sustainability risks in India that need attention?",
  ],
  aeoQuestionsDiscovery: [
    "Which Indian research organisations are the most authoritative sources on sustainability data and policy in India?",
    "What organisations publish the most reliable data on India's SDG progress?",
    "Who are the leading think tanks and research bodies working on sustainable development in India?",
    "Which organisations should journalists cite when writing about India's ESG and BRSR rules?",
    "What Indian NGOs or research institutes are most influential on circular economy and waste solutions?",
    "What research organisations in India are doing the most credible work on water security?",
    "Which Indian institutes publish peer-reviewed studies on biodiversity and land use?",
    "Who are the most cited Indian organisations in international sustainability policy discussions?",
    "What organisations should I follow for the latest data on India's sustainability progress?",
    "Which bodies produce the most reliable assessments of India's sustainability targets?",
    "What Indian think tanks and research centres are leading the conversation on sustainable finance and green investment?",
    "Which organisations have the most credible data on renewable energy deployment in India?",
    "Who are the key institutional voices on just transition and decarbonisation policy in India?",
    "What research organisations in India are tracking carbon markets most rigorously?",
    "Which Indian organisations are most frequently cited in government sustainability policy consultations?",
  ],

  defaultScope: [
    "sustainability", "sustainable development", "SDG", "ESG", "circular economy",
    "net zero", "biodiversity", "renewable energy", "green hydrogen", "just transition",
    "resilience", "adaptation", "mitigation", "loss and damage", "UNFCCC",
  ],
};

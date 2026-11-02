# BioSimilar Agent System: Interaction Flows

## 1. Main Flow: User Query → Dossier

```
User: "Should we switch from Remicade to Renflexis for RA?"
│
├─► ORCHESTRATOR [Planning Phase]
│   └─ Decide: biologic path, need state rules?, how many alternatives?
│      Output: Research plan
│
├─► DRUG RESOLVER [Execution Phase]
│   ├─ Input: "Remicade" → Output: canonical_id, originator record
│   └─ Input: "Renflexis" → Output: canonical_id, biosimilar record
│
├─► RETRIEVERS [Parallel Execution]
│   ├─ FDA_RETRIEVER
│   │  └─ Fetch: approval dates, interchangeability status
│   ├─ PATENT_RETRIEVER
│   │  └─ Fetch: exclusivity cliffs, challenge status
│   ├─ CLINICAL_RETRIEVER
│   │  └─ Fetch: switching studies for RA indication
│   ├─ PRICING_RETRIEVER
│   │  └─ Fetch: WAC, ASP, formulary benchmarks
│   └─ STATE_RULES_RETRIEVER
│      └─ Fetch: state-specific substitution authority
│
├─► EXTRACTOR [Sequential]
│   └─ Input: raw retriever outputs
│      Output: structured records with schema validation
│                {study_id, outcome, population_size, confidence}
│
├─► VERIFIER [Sequential]
│   └─ Input: extracted claims + source URLs
│      For each claim:
│      ├─ Fetch source text
│      ├─ Check if claim matches source
│      └─ Assign confidence score (0.0–1.0)
│      Output: {claim, confidence, evidence_quote}
│
└─► SYNTHESIZER [Final Assembly]
    └─ Input: verified claims + resolved drugs
       Output: dossier with recommendation
               {exec_summary, regulatory, clinical, cost, state_rules, limitations}
```

---

## 2. Retriever Retry Loop (Adaptive Queries)

```
RETRIEVER: "Find switching studies for infliximab biosimilars"
│
├─ Query 1: "infliximab biosimilar clinical trial switching"
│  └─ Result: 3 papers found ✓
│
└─ [If Query 1 had returned 0 results]
   ├─ Query 2: "TNF inhibitor biosimilar switch efficacy"
   │  └─ Result: 5 papers found ✓
   │
   └─ [If Query 2 had returned 0 results]
      ├─ Query 3: "infliximab-dyyb clinical trial RA"
      │  └─ Result: 2 papers found ✓
      │
      └─ [If Query 3 had returned 0 results]
         └─ Mark as "NO EVIDENCE FOUND" and report to Orchestrator
```

---

## 3. Extraction with Schema Validation

```
Raw Abstract:
"In our Phase 3 trial (n=450), infliximab biosimilar TS301 showed
non-inferiority vs originator in UC patients over 30 weeks. Primary
endpoint achieved (p<0.001). Safety profiles comparable."

│
├─► EXTRACTOR [with schema]
│
├─ Required field: study_id
│  └─ Not found in text → confidence: 0.0 (mark for verification)
│
├─ Required field: primary_endpoint
│  └─ Found: "non-inferiority" → confidence: 0.95 ✓
│
├─ Required field: outcome
│  └─ Found: "achieved" → PASS → confidence: 0.98 ✓
│
├─ Required field: population_size
│  └─ Found: "n=450" → confidence: 0.99 ✓
│
└─ Optional field: adverse_events_serious
   └─ Not found in abstract → null (don't hallucinate)

Output: {
  "study_id": null,
  "primary_endpoint": "non-inferiority",
  "outcome": "PASS",
  "population_size": 450,
  "adverse_events_serious": null,
  "extracted_text": "...",
  "extraction_confidence": 0.92
}
```

---

## 4. Verification Workflow: Checking a Claim

```
VERIFIER receives claim:
Claim: "Renflexis (infliximab-dyyb) is FDA-approved as interchangeable with Remicade"
Source: https://www.fda.gov/drugs/biosimilars/...

│
├─ Step 1: Fetch source
│  └─ GET https://www.fda.gov/drugs/biosimilars/...
│     Result: 200 OK, content loaded
│
├─ Step 2: Search for key phrases in source
│  ├─ Find "infliximab-dyyb"? ✓ Yes
│  ├─ Find "interchangeable"? ✓ Yes
│  └─ Find "Remicade"? ✓ Yes
│
├─ Step 3: Extract supporting quote
│  └─ "FDA determined that Renflexis is interchangeable with Remicade..."
│
├─ Step 4: Assess confidence
│  ├─ Claim exact match with quote? YES → confidence: 1.0
│  ├─ Claim directionally correct but paraphrased? → confidence: 0.9
│  ├─ Claim supported but source hedges? → confidence: 0.7
│  ├─ Claim ambiguous or unsupported? → confidence: 0.5
│  └─ Claim contradicted? → confidence: 0.0
│
└─ Output: {
     "verification_status": "VERIFIED",
     "confidence": 1.0,
     "evidence_quote": "FDA determined that Renflexis is interchangeable...",
     "source_url": "https://www.fda.gov/...",
     "verification_timestamp": "2024-10-19"
   }
```

---

## 5. Conflict Resolution: Multiple Studies Say Different Things

```
SYNTHESIZER receives 3 studies:

Study A (PMID: 11111111)
  └─ Outcome: Non-inferiority shown (p < 0.001)
     Confidence: 0.98

Study B (PMID: 22222222)
  └─ Outcome: Non-inferiority NOT shown (p = 0.08)
     Confidence: 0.85

Study C (PMID: 33333333)
  └─ Outcome: Non-inferiority shown (p < 0.01)
     Confidence: 0.95

│
├─► SYNTHESIZER: "Don't average. Surface both views."
│
└─ Dossier section:
   "
   Clinical Evidence (Heterogeneous):
   
   Three switching trials found. Two showed non-inferiority:
   - Study A (n=450): Non-inferior at primary endpoint (PMID: 11111111)
   - Study C (n=380): Non-inferior at primary endpoint (PMID: 33333333)
   
   One did not meet non-inferiority criteria:
   - Study B (n=200): Marginal outcome at p=0.08 (PMID: 22222222)
     [Smaller N; different patient population]
   
   Interpretation: Heterogeneous results suggest biosimilar efficacy
   is comparable for most patients but may not apply universally.
   Recommend case-by-case review, especially for Study B population.
   
   Overall confidence: MODERATE (conflicting evidence)
   "
```

---

## 6. Error Recovery: Retriever Timeout

```
ORCHESTRATOR sends task: "Retrieve clinical studies for pembrolizumab switching"
│
├─► RETRIEVER attempts:
│
├─ PubMed API call #1
│  └─ Timeout (>30s) → FAIL
│
├─ Retry logic (exponential backoff):
│  ├─ Wait 2s, retry #2
│  │  └─ Timeout → FAIL
│  ├─ Wait 5s, retry #3
│  │  └─ Success: 5 results ✓
│
└─ Report to ORCHESTRATOR:
   {
     "status": "partial_success",
     "message": "Retrieved after 3 attempts (2 timeouts)",
     "results_count": 5,
     "retrieval_duration": "40s",
     "reliability": "degraded (timeouts encountered)"
   }

ORCHESTRATOR observes: retriever succeeded but was slow.
Decision: 
  ├─ If time budget allows: continue (don't retry)
  └─ If time budget tight: mark results as "low confidence" in output
```

---

## 7. Missing Data Handling: Pricing Not Available

```
PRICING_RETRIEVER task: "Find WAC and ASP for infliximab-dyyb"
│
├─ Query CMS pricing databases
│  └─ Result: No data found (drug too new, not yet in system)
│
├─ Query NADAC
│  └─ Result: No data found
│
├─ Report to ORCHESTRATOR:
   {
     "status": "no_data",
     "message": "Pricing not found in public databases",
     "reason": "Biosimilar may be too new or pricing not yet published"
   }

EXTRACTOR: Doesn't run on this (no data to extract)

VERIFIER: Doesn't run (no claim to verify)

SYNTHESIZER receives "pricing: null" and handles it:
│
└─ Dossier section:
   "
   Cost Analysis:
   
   Pricing information not available in public databases.
   Biosimilar launched [date]; public benchmarking lags real-world
   adoption. Contact your specialty pharmacy or PBM for current
   contract rates.
   
   ⚠️  Warning: Published benchmarks do not reflect negotiated rates.
   Actual savings will vary by formulary and purchase volume.
   "
```

---

## 8. Confidence Scoring Throughout Pipeline

```
Input: "Should we switch from X to Y?"
│
├─ Drug Resolution confidence: 0.98 (canonical IDs matched)
│
├─ FDA Status confidence: 0.99 (directly from FDA)
│
├─ Clinical Evidence confidence: 0.75
│  ├─ Study A: 0.98
│  ├─ Study B: 0.50 (conflicting)
│  └─ Study C: 0.95
│  → Average: 0.81; but report individual scores, not average
│
├─ Pricing confidence: 0.0 (no data)
│
├─ State Rules confidence: 0.95 (state pharmacy board)
│
├─ Verifier adjustments:
│  └─ Each claim's confidence adjusted by verification process
│     Before: 0.85, After verification: 0.92
│
└─ Final Dossier confidence: 0.80 (weighted across all sections)
   ├─ "Recommendation: CONDITIONAL (confidence: 0.80)"
   ├─ "Clinical evidence supports switch (0.77), but pricing TBD"
   └─ "Recommend board review given conflicting studies (Study B)"
```

---

## 9. Session Context: What's Shared Across Agents

```
session_context = {
  "session_id": "sess_oct_19_001",
  "user_query": "Should we switch from Remicade to Renflexis for RA?",
  "created_at": "2024-10-19T14:30:00Z",
  
  "drug_resolver_output": {
    "originator": {"brand": "Remicade", ...},
    "biosimilar": {"brand": "Renflexis", ...}
  },
  
  "orchestrator_plan": {
    "path": "biologic",
    "sources_needed": ["fda", "patents", "clinical", "pricing", "state"],
    "priority_indication": "Rheumatoid Arthritis"
  },
  
  "retriever_outputs": {
    "fda": { ... },
    "patents": { ... },
    "clinical": [ ... ],
    "pricing": null,
    "state": { ... }
  },
  
  "extracted_data": {
    "studies": [
      { "study_id": "...", "outcome": "PASS", ... }
    ],
    "labels": [ ... ]
  },
  
  "verified_claims": [
    { "claim": "...", "confidence": 0.95, "source": "..." },
    { "claim": "...", "confidence": 0.50, "source": "...", "note": "conflicting study" }
  ],
  
  "final_dossier": {
    "exec_summary": "...",
    "regulatory": { ... },
    "clinical": { ... },
    "cost": { ... },
    "state_rules": { ... },
    "recommendation": "CONDITIONAL",
    "confidence": 0.80,
    "limitations": [ ... ]
  }
}
```

All agents read from and write to this context. It's the source of truth for the research session.


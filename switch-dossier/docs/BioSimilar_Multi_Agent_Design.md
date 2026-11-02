# BioSimilar Switch Research Agent: Multi-Agent Architecture Design

## Executive Summary

Your system needs a **coordinator + specialist agents** pattern:

```
User Input
    ↓
[Orchestrator Agent] ← Plans research path & coordinates
    ↓ ↓ ↓ ↓ (parallel/sequential)
[Drug Resolver] [Retriever Agent] [Verifier Agent] [Synthesizer Agent]
    ↓              ↓                ↓                ↓
Canonical IDs   Raw Evidence    Fact Checks    Final Dossier
```

This design ensures **correctness through specialization**—each agent owns one critical concern rather than asking a single agent to research, verify, and synthesize all at once.

---

## 1. Agent Roles & Responsibilities

### 1.1 Orchestrator Agent (Coordinator)
**Owns:** Planning, routing, decision-making
**Input:** User drug name + context (indication, state, health system size)
**Output:** Research plan, final dossier

**Responsibilities:**
- **Drug resolution:** Convert user input ("Keytruda vs pembrolizumab") → canonical identifiers
- **Path planning:** Decide regulatory route (biologic vs small-molecule, FDA vs EMA data needed?)
- **Task sequencing:** Which research must happen first? What can run in parallel?
- **Error recovery:** If retriever returns no results, reformulate the query and retry
- **Final synthesis:** Aggregate specialist outputs into dossier structure

**Key decisions this agent makes:**
1. Is this a biologic or small-molecule? (changes data sources entirely)
2. How many alternatives are there? (affects research depth)
3. What jurisdiction? (state substitution rules matter)
4. Should we focus on one indication or all approved uses?

**Why this agent exists:** Prevents the complexity from overwhelming a single pass. A ReAct loop at this level (plan → execute → observe → replan) handles adaptive research.

---

### 1.2 Drug Resolver Agent
**Owns:** Entity resolution, normalization
**Input:** User-typed drug name (messy)
**Output:** Structured drug record + identifiers

**Responsibilities:**
- **Canonical mapping:** "Keytruda" → "pembrolizumab" (generic) + "P0001" (our internal ID)
- **Biosimilar suffix handling:** "infliximab" vs "infliximab-dyyb" (Remicade vs Renflexis)
- **Active lookup:** Query FDA Purple/Orange Books to confirm current status
- **Alternatives discovery:** Find all approved biosimilars or generics for the originator
- **Indication scoping:** Map user's indication to FDA-approved indications

**Spec for resolution output:**
```json
{
  "requested_name": "Keytruda",
  "canonical_generic": "pembrolizumab",
  "type": "biologic",
  "originator": {
    "brand": "Keytruda",
    "manufacturer": "Merck",
    "fda_nda": "BLA125514",
    "approved": "2014-09-04"
  },
  "alternatives": [
    {
      "type": "biosimilar",
      "brand": "Nyvepria",
      "generic": "pembrolizumab-dyyb",
      "manufacturer": "Sandoz",
      "fda_approval": "2023-01-20",
      "interchangeable": true
    }
  ],
  "indications": ["Melanoma", "NSCLC", "Hodgkin Lymphoma", ...],
  "confidence": 0.98
}
```

**Why this agent exists:** Resolving drugs correctly is non-negotiable. If the Retriever searches for "Keytruda pricing" and doesn't find it because the database uses "pembrolizumab," the entire research fails silently. This agent owns correctness at the entry point.

---

### 1.3 Retriever Agent (Parallel Workers)
**Owns:** Fetching raw evidence from all sources
**Runs:** Mostly in parallel (can reformat and retry based on results)

**Sub-tasks (can be sequential steps within this agent or sub-agents):**

#### 1.3a FDA Regulatory Status Retriever
- Query Purple Book (brand-name drugs)
- Query Orange Book (exclusivity periods, Paragraph IV challenges)
- Query FDA openFDA API (approval dates, manufacturer info)
- **Output:** Structured record with approval status, exclusivity end dates, patent expirations

#### 1.3b Patent & Exclusivity Retriever
- Parse Orange Book patent listings
- Cross-reference with USPTO Patent Full-Text Database
- Track Paragraph IV challenges and their status
- Compute exclusivity cliff (when can biosimilar launch?)
- **Output:** Patent timeline, earliest realistic market entry date

#### 1.3c Clinical Evidence Retriever
- PubMed query for switching studies
- ClinicalTrials.gov for ongoing trials
- Re-query with different search terms if first pass returns nothing
- **Output:** List of high-confidence switching studies (structured citations)

#### 1.3d Pricing Retriever
- NADAC (National Average Drug Acquisition Cost) public data
- Medicare Part B ASP (Average Selling Price)
- CMS pricing transparency files
- **Caution:** These are not contract prices. Normalize and surface this clearly.
- **Output:** Benchmark pricing, with caveats about real-world variation

#### 1.3e State Substitution Rules Retriever
- Query state pharmacy board rules (if user specified a state)
- Determine if automatic substitution is allowed or requires prescriber consent
- **Output:** State-specific substitution authority and constraints

**Why this agent pattern exists:** Retrievers are I/O bound and can fail gracefully. A single retriever that times out blocks everything. Parallel retrievers mean one slow source doesn't stall the others.

---

### 1.4 Extractor Agent
**Owns:** Structured data extraction from unstructured text
**Input:** Raw abstracts, labels, study text from retriever
**Output:** Validated schema objects

**Key extractions:**

**From clinical abstracts:**
```json
{
  "study_id": "PMID:12345678",
  "primary_endpoint": "non-inferiority margin 10%",
  "outcome": "PASS" | "FAIL" | "INCONCLUSIVE",
  "population_size": 200,
  "washout_period": "4 weeks",
  "dosing_interval": "every 2 weeks",
  "adverse_events_serious": 3,
  "adverse_events_total": 15,
  "confidence": 0.95
}
```

**From FDA labels:**
```json
{
  "formulation": "100mg/0.5mL prefilled syringe",
  "storage": "2-8°C",
  "mechanism_of_action": "...",
  "contraindications": [...]
}
```

**Mechanism:**
1. Feed abstract + extraction schema to Claude
2. Extract fields, flag confidence levels
3. If confidence < threshold or required fields missing, mark as "not reported" (do NOT fabricate)
4. Return structured record + source URL for verification step

**Why this agent exists:** Abstracts are prose; cost models and comparisons need structured data. Schema-enforced extraction prevents hallucination—a missing field returns `null`, not a made-up number.

---

### 1.5 Verifier Agent
**Owns:** Fact-checking and citation validation
**Input:** Extracted claims + their source URLs
**Output:** Verified claims + confidence scores

**Verification workflow:**

```
Claim: "Infliximab biosimilar Renflexis showed non-inferiority in UC"
Source: PMID:29123456
↓
1. Fetch abstract from PubMed
2. Check: Does the abstract say "non-inferiority" + "ulcerative colitis"?
3. Extract exact language from paper
4. Compare to claim
5. Report: VERIFIED / PARTIALLY_SUPPORTED / CONTRADICTED / NOT_FOUND
```

**Each claim gets a confidence score:**
- **1.0 (Verified):** Claim exactly matches source text
- **0.9 (Strongly supported):** Claim matches but paraphrased
- **0.7 (Supported with caveats):** Claim is directionally correct but source hedges
- **0.5 (Ambiguous):** Source is unclear or relevant passage is absent
- **0.0 (Contradicted):** Source explicitly disagrees

**Verification schema:**
```json
{
  "claim": "Renflexis is interchangeable with Remicade for RA",
  "source_url": "https://pubmed.ncbi.nlm.nih.gov/29123456",
  "verification_status": "VERIFIED",
  "evidence_quote": "In the Phase 3 REFLECTIONS trial, TS301 [infliximab biosimilar] met criteria for interchangeability...",
  "confidence": 0.95,
  "tags": ["FDA_approved", "clinical_trial"]
}
```

**Why this agent exists:** Hallucination is the biggest risk in your use case. Verification gates synthesis—if a claim scores < 0.7, it gets flagged or removed from the final output. This is where you earn trust.

---

### 1.6 Synthesizer Agent
**Owns:** Dossier assembly, conflict resolution, recommendations
**Input:** Verified claims from all retrievers + extractions
**Output:** Final dossier + recommendation

**Dossier structure:**

```
1. Executive Summary
   - Drug name, indication, current market
   - Biosimilar alternative(s)
   - Recommendation (SWITCH / CONDITIONAL / NOT RECOMMENDED)

2. Regulatory Status
   - FDA approval timeline
   - Interchangeability status (for biosimilars)
   - Patent exclusivity cliffs

3. Product Comparison
   - Formulation, device, storage
   - Manufacturing differences (if material)
   - Switching panel requirement?

4. Clinical Evidence
   - Switching studies (with confidence scores)
   - Conflicting evidence (DON'T average; surface disagreement)
   - Study limitations

5. Cost Analysis
   - WAC/ASP comparison (with disclaimer)
   - Formulary impact scenarios
   - ROI timeline

6. State-Specific Rules
   - Substitution authority
   - Prescriber notification requirements

7. Limitations & Caveats
   - Data gaps (e.g., "No switching study for indication X")
   - Price caveat ("ASP does not reflect negotiated rates")
   - Recommendation confidence

8. Evidence & Citations
   - All claims linked to sources
   - Verification status for each claim
```

**Conflict resolution:** If Study A says "non-inferior" and Study B says "inferior at p=0.08," surface both. Don't average confidence scores or pick one winner. The clinical pharmacist decides how to interpret heterogeneity.

**Why this agent exists:** Synthesis is where your recommendations live. Separating it from verification means the verifier can be strict (flag anything uncertain) and the synthesizer can thoughtfully weigh evidence rather than both happening at once.

---

## 2. Data Flow & Tool Access

### 2.1 Tool Allocation by Agent

| Agent | Tools | Notes |
|-------|-------|-------|
| Orchestrator | LLM reasoning only (no tools during planning) | Plans the research path; routes to specialists |
| Drug Resolver | FDA API client, internal drug ID database, PubMed E-utilities for confirmation | Read-only |
| Retriever | FDA API, PubMed E-utilities, ClinicalTrials.gov API, CMS pricing APIs, state pharmacy board DB | Read-only; timeouts expected |
| Extractor | None (pure LLM with schema) | Consumes retriever outputs |
| Verifier | PubMed fetch, URL fetch for source text, schema validator | Read-only; fact-checking |
| Synthesizer | None (pure LLM with schema) | Compiles verified facts into narrative |

### 2.2 Error Handling & Retry Logic

**Retriever fails (no results):**
```
Original query: "infliximab biosimilar switching clinical trial"
↓ [No results]
Orchestrator observes: "zero results"
↓
Reformulate & retry: "infliximab switching study efficacy"
↓ [Still nothing]
Reformulate & retry: "TNF inhibitor biosimilar switch safety"
↓ [Success or mark as "not found"]
```

**Extractor confidence too low:**
```
Extracted: {"outcome": "??", "confidence": 0.4}
↓
Flag in verification: "Study outcome not clearly reported"
↓
Verifier checks source: Confirms outcome is ambiguous
↓
Synthesizer: "Evidence inconclusive (see citation)"
```

**Verifier cannot access source:**
```
Claim: "Study shows X"
Source: https://doi.org/10.xxxxx
↓
Verifier tries DOI resolver, PubMed, Google Scholar
↓ [All fail]
Result: "UNVERIFIED - source not accessible"
↓
Synthesizer flags: "Claim not independently verified"
```

---

## 3. Memory & Context Management

### 3.1 Shared Context (Persistent Across Agents)

Each research session maintains a context object:

```json
{
  "session_id": "sess_2024_10_biosimilar_01",
  "user_query": "Should we switch from Remicade to Renflexis for RA?",
  "resolved_drug": { /* from Drug Resolver */ },
  "research_plan": { /* from Orchestrator */ },
  "retrieved_evidence": {
    "fda_status": { /* from FDA Retriever */ },
    "patents": { /* from Patent Retriever */ },
    "clinical_studies": [ /* from Clinical Retriever */ ],
    "pricing": { /* from Pricing Retriever */ },
    "state_rules": { /* from State Rules Retriever */ }
  },
  "extracted_data": {
    "studies": [ /* Schema-validated study records */ ],
    "labels": [ /* Formulation records */ ]
  },
  "verified_claims": [
    {
      "claim": "...",
      "confidence": 0.95,
      "source": "..."
    }
  ],
  "dossier": { /* Final output */ }
}
```

### 3.2 Inter-Agent Communication

**Synchronous calls (wait for result):**
- Orchestrator calls Drug Resolver (blocks until done)
- Orchestrator waits for all Retrievers to finish

**Parallel execution:**
```
Orchestrator issues:
├─ Retrieve FDA status
├─ Retrieve patents
├─ Retrieve clinical studies
└─ Retrieve pricing
↓ [Wait for all]
Orchestrator → Extractor (extract what was retrieved)
Extractor → Verifier (verify extracted claims)
Verifier → Synthesizer (compile dossier)
```

---

## 4. Implementation Approach

### 4.1 Using Claude Agent SDK

```python
from anthropic import Anthropic

client = Anthropic()

# Orchestrator runs main loop
def orchestrator(user_query):
    # Step 1: Plan
    plan = client.messages.create(
        model="claude-opus-5-5",
        max_tokens=2000,
        system="You are a research coordinator...",
        messages=[{"role": "user", "content": f"Plan research for: {user_query}"}]
    )
    
    # Step 2: Execute in parallel (simplified; use asyncio for true parallelism)
    resolved_drug = drug_resolver(user_query)
    fda_status = retrieve_fda_status(resolved_drug)
    patents = retrieve_patents(resolved_drug)
    studies = retrieve_studies(resolved_drug)
    pricing = retrieve_pricing(resolved_drug)
    
    # Step 3: Extract
    extracted = extractor({"studies": studies, "fda_status": fda_status})
    
    # Step 4: Verify
    verified = verifier(extracted)
    
    # Step 5: Synthesize
    dossier = synthesizer(verified, resolved_drug)
    
    return dossier
```

### 4.2 Handling Tool Failures Gracefully

Each agent should:
1. **Define retries:** Retriever retries with reformulated queries
2. **Define fallbacks:** If pricing data unavailable, note "not reported"
3. **Track confidence:** Mark results with how certain we are
4. **Report gaps:** Synthesizer surfaces "We couldn't find..." in output

### 4.3 Testing Strategy

**Ground truth evaluation:**
- Pick 3–5 drugs you know well
- Build expected dossier manually (you + domain expert)
- Run system; compare on:
  - **Fact accuracy:** Do dates, approvals, study outcomes match?
  - **Citation validity:** Can you click on every claim's source and verify?
  - **Evidence detection:** Did system find the key switching studies?
  - **Confidence calibration:** When system says 0.95, is it right?

---

## 5. Key Design Principles

### 5.1 Specialization Over Generalization
**Don't:** Ask one agent to research + extract + verify + synthesize
**Do:** Each agent owns one concern; specialists do that better

### 5.2 Verification Gates Synthesis
**Don't:** Average conflicting studies or drop uncertainty
**Do:** Flag conflicts, surface evidence gaps, let human expert decide

### 5.3 Schema-Driven Extraction
**Don't:** "Extract whatever you find"
**Icdo:** Define required fields; return `null` if not found (never hallucinate)

### 5.4 Adaptive Retrieval
**Don't:** One query, accept empty results
**Do:** Orchestrator observes empty result, reformulates query, retries

### 5.5 Transparent Limitations
**Don't:** Present benchmark prices as contract rates
**Do:** Explicitly label assumptions and caveats

### 5.6 Read-Only Tools
System has no write access to clinical records, prescriptions, or formularies. All actions are informational.

---

## 6. Implementation Priorities

### Phase 1: MVP (Orchestrator + Retriever + Synthesizer)
- Resolve drug name
- Retrieve from FDA, pricing, 1–2 key studies
- Synthesize into basic dossier
- Goal: Can you produce a dossier at all?

### Phase 2: Extraction + Verification
- Add Extractor (schema validation)
- Add Verifier (fact-checking)
- Ground-truth test on 3 drugs
- Goal: Are you accurate and citeable?

### Phase 3: Robustness
- Implement retry logic in Retriever
- Expand sources (more clinical trials, state rules)
- Parallelization of retrieval
- Goal: Can you handle edge cases?

### Phase 4: Integration
- Web UI for researchers
- Persistent dossier storage
- User feedback loop (is your recommendation right?)
- Goal: Production-ready system

---

## 7. Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Hallucinated numbers (cost, dates, efficacy) | Verifier checks every claim against source |
| Missed alternatives | Drug Resolver queries FDA actively |
| Stale data | Orchestrator logs retrieval timestamps; user sees "last updated" |
| Read as clinical advice | UI/dossier header: "For professional use, not patient-facing" |
| Missed state rules | Expand state rules DB; flag if rule not found |
| Conflicting studies | Surface disagreement; don't average |

---

## 8. Next Steps

1. **Build Drug Resolver** as your first working piece. Test it on 10 drugs to validate entity resolution.
2. **Build Retriever** (start with FDA API only). Can you reliably fetch approval dates?
3. **Build Verifier** in parallel. Can you check "FDA approved 2023-01-20" against the source?
4. **Integrate Orchestrator** once the above three work.
5. **Ground-truth test** on 3 drugs before scaling.

---

## Appendix: Tool Specifications

### FDA API Queries
```
Purple Book: https://open.fda.gov/apis/drug/drugsfda/
Orange Book: https://www.fda.gov/drugs/drug-approvals-and-databases/orange-book-data-files

Example query:
GET /drug/drugsfda.json?search=active_ingredient:("pembrolizumab")&limit=100
```

### PubMed E-utilities
```
https://pubmed.ncbi.nlm.nih.gov/help/api_eutilities/
Example: Search for switching studies
GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi
  ?db=pubmed
  &term=("infliximab biosimilar" OR "infliximab-dyyb") AND switch
  &rettype=json
```

### State Rules Database
Example schema for state substitution rules:
```json
{
  "state": "CA",
  "rule": "Automatic substitution allowed with prescriber consent",
  "applies_to": "biosimilar",
  "link": "https://..."
}
```


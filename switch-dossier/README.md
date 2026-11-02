# Switch Dossier: Generic / Biosimilar Switch Research Agent

CMU Agentics AI course capstone (track: Research Assistant).

A clinical pharmacist or market access analyst types a drug name, optionally with a dosage and allergy information. A multi-agent system then researches whether a health system should move patients from the brand-name drug to an available generic or biosimilar, and produces a **switch dossier** ending in a recommendation with its limits stated.

> **Project status.** The front-end UI and the design are complete. The retrieval clients are written and tested. The agent pipeline (orchestrator, extractor, verifier, synthesizer) is **not implemented yet**. The dossier shown in the UI is **sample data**, not output from the agents. See [Status](#status).

## The problem

Biosimilar switching is one of the larger cost-reduction opportunities in US healthcare, but the information needed to decide sits in places that do not connect: FDA's Purple and Orange Books (regulatory status), overlapping patent listings, journal articles (switching evidence, as prose), public price benchmarks, and fifty state practice acts. A pharmacist assembles this by hand before each Pharmacy and Therapeutics committee meeting. It takes days per drug and goes stale with every new launch.

The user is a professional. This is decision support, not patient-facing clinical advice.

## Why an agent, not a single prompt

- **Facts change and are not in the model.** Approvals and exclusivity shift constantly, so the system must look things up.
- **Fabricated facts are unacceptable.** A separate verifier checks each claim against its source text; unsupported claims are dropped.
- **The research path is not known in advance.** Biologics and small molecules follow different regulatory routes, so the plan is adaptive (ReAct loop, query reformulation on empty results).
- **Some output must be computed.** Cost and date reasoning use tools, not model arithmetic.

## Architecture

```
User input (drug, optional dose / allergies / state / indication)
        │
  [Orchestrator] plans path, owns retries
        │
  [Drug Resolver] name → canonical generic, alternatives, biologic vs small molecule
        │
  ┌─────┴──────── parallel retrievers (read-only) ────────┐
  FDA status   Patent/exclusivity   Clinical evidence   Pricing   State rules
  └─────┬─────────────────────────────────────────────────┘
  [Extractor]  schema-enforced fields; missing → "not reported"
        │
  [Verifier]   claim vs. source text; confidence < 0.7 is dropped
        │
  [Synthesizer] dossier + recommendation; conflicts shown, not averaged
```

Full design: [docs/BioSimilar_Multi_Agent_Design.md](docs/BioSimilar_Multi_Agent_Design.md) and [docs/Agent_Interaction_Flows.md](docs/Agent_Interaction_Flows.md).

**Data sources:** openFDA (labels, Drugs@FDA), PubMed E-utilities, ClinicalTrials.gov, NADAC (data.medicaid.gov), and a state substitution rules table maintained in [data/state_rules.json](data/state_rules.json).

**Safety:** every claim needs a resolving citation; tools are read-only; pricing assumptions are labeled (NADAC is a benchmark, not a contracted rate); the recommendation is capped when evidence is thin; expert review is required.

## Repository layout

| Path | What it is |
|---|---|
| `public/index.html` | The web UI: request form, agents-working view, dossier view. Single file, no build step. |
| `lib/tools.js` | Read-only retrieval clients (openFDA, PubMed, ClinicalTrials.gov, NADAC) and deterministic computations (dose parsing, annual cost, BPCIA exclusivity dates). |
| `lib/llm.js` | Anthropic Messages API client with schema-enforced output via forced tool use. Not yet called by any agent. |
| `data/` | State substitution rules table (baseline text only) and a manual interchangeability overrides file (empty). |
| `scripts/sample_retrieval.mjs` | Runs the retrieval clients for one drug and saves raw results. |
| `samples/` | Real outputs from that script for infliximab and adalimumab. |
| `docs/` | Design documents. |

## Setup

Requires Node 20 or newer. There are no dependencies to install.

```bash
git clone <this-repo-url>
cd switch-dossier
```

## Usage

**1. Review the UI (no setup needed).** Open `public/index.html` in a browser, or serve it:

```bash
python3 -m http.server 4310 --directory public
```

Then open http://localhost:4310. On the first screen, click **Skip to sample dossier**, or click **Generate dossier** to watch the simulated agent run (the pipeline view and activity log are scripted). In the dossier, click any blue claim chip (for example `C7`) to open the evidence drawer.

**2. Run the retrieval layer against live public APIs** (needs internet):

```bash
node scripts/sample_retrieval.mjs infliximab
node scripts/sample_retrieval.mjs adalimumab
```

This writes `samples/retrieval_<drug>.json` and prints counts of labels, Drugs@FDA applications, PubMed abstracts, trials and NADAC rows.

## Sample inputs and outputs

- [samples/retrieval_infliximab.json](samples/retrieval_infliximab.json) and [samples/retrieval_adalimumab.json](samples/retrieval_adalimumab.json) are raw results from the retrieval clients (retrieved 2026-11-01).
- They are smoke tests of the data layer, not dossiers and not validated findings. Two things to know when reading them:
  - Infliximab returns no NADAC rows, because it is an infused Part B drug. The dossier flags this as a data gap.
  - The adalimumab `costExample` is a rough median across NDCs from several products. The planned resolver would separate products first.
- The sample dossier in `public/index.html` is hardcoded placeholder content that shows the layout. It is labeled as sample data on the page.

## Status

| Component | State |
|---|---|
| UI (request, agent run, dossier, evidence drawer, scenario calculator) | Done, using sample data |
| Retrieval clients and computations (`lib/tools.js`) | Written; exercised by `scripts/sample_retrieval.mjs`; no automated tests |
| LLM client (`lib/llm.js`) | Written; not yet exercised |
| Resolver, orchestrator, extractor, verifier, synthesizer, server | Designed, not implemented |
| Ground-truth evaluation (fact accuracy, extraction precision/recall, citation validity) | Planned in the design, not run |

## Known gaps

- No open API was found for Purple Book interchangeability designations or for patent and litigation listings. The design handles these as flagged data gaps, with a manual overrides file for interchangeability.
- State rules are a general baseline only; per-state entries are not populated.
- Pricing covers NADAC only. Medicare Part B ASP is not wired in.
- Vector-indexed memory from the Week 3 design is not built.

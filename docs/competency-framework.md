# Bulletproof Automation Builder Pathway
## Competency Framework and Certification Standard

**Version 2.0 (Draft)** · Issuing body: Bulletproof Automations · Owner: Johnathan Lightfoot
Issued: [DATE] · Platform basis for current assessments: n8n [VERSION] · Next review: [DATE + 12 months]

---

## 1. Purpose

This framework defines the credentials issued under the Bulletproof Automation Builder Pathway: what each attests, what evidence is required, how it is assessed, and where the pass line sits.

It exists so that candidates know what is being measured, assessors apply one standard, and employers — including Bulletproof Automations itself — can interpret what a holder can actually do.

**The subject of this pathway is automation engineering.** n8n is the platform on which competence is currently demonstrated, not the subject being certified. This distinction is deliberate and protects the credential's value against platform change.

---

## 2. The pathway

| Stage | Credential | Type | What it establishes |
|---|---|---|---|
| 1 | **Bulletproof Automation Foundations Certificate** | Certificate of completion | Completed foundational training and demonstrated basic workflow-building proficiency |
| 2 | **Bulletproof Certified Automation Builder** (BCAB) | Professional certification | Can independently design, integrate, troubleshoot, test, and document moderately complex automation systems |
| 3 | **Bulletproof Certified Automation Engineer** (BCAE) | Professional certification | Can architect, deploy, secure, operate, monitor, and govern production automation systems |

Stage 1 is active. Stage 2 launches with the first Intermediate cohort. Stage 3 is defined but not issued.

**Training and certification are separate products.** Completing a cohort does not confer a certification. It qualifies the learner to attempt the assessment.

---

## 3. Stage 1 — Bulletproof Automation Foundations Certificate

### 3.1 Status

**This is a certificate of completion, not a professional certification.** It makes no independent competency claim beyond readiness to progress. This is stated on the certificate itself.

### 3.2 What it attests

The holder completed the Foundations training programme and demonstrated the ability to:

- navigate n8n and describe workflow structure in plain language;
- build a workflow from trigger to output;
- inspect items, fields, and JSON, and read node input and output;
- use expressions to move data between nodes;
- connect an application using a safely stored credential;
- make a basic API request and read the response;
- apply IF and Switch logic with a fallback;
- implement basic error handling;
- add a controlled AI step;
- test multiple paths, including one handled failure;
- export, document, and explain a workflow.

### 3.3 Award standard

Three requirements, all mandatory:

1. **Participation** — meets the published attendance minimum.
2. **Portfolio evidence** — submits the required weekly artifacts (workflow export, screenshots, notes) for each class.
3. **Capstone** — completes the capstone to the published specification and explains it satisfactorily in the walkthrough.

There is no separate examination and no direct-entry route. A certificate of completion cannot be awarded for training that was not completed.

### 3.4 Certificate wording

> [Name] completed the Bulletproof Automation Foundations programme and demonstrated the foundational skills required to progress to intermediate automation training. This certificate records completion of training. It is not a professional certification.

---

## 4. Stage 2 — Bulletproof Certified Automation Builder (BCAB)

### 4.1 What this certification attests

The holder can independently take a moderately complex automation requirement and design, build, integrate, harden, document, and maintain a solution — and can diagnose a malfunctioning system they did not build.

**Stated limitation on the credential:** does not attest to competence in scaling, infrastructure administration, deployment pipelines, or enterprise security architecture. Those are Stage 3.

### 4.2 Competency domains

| # | Domain | Competency at this level |
|---|---|---|
| 1 | **Data Engineering** | Transform nested, multi-item, inconsistent, and incomplete workflow data |
| 2 | **Integrations & APIs** | Build integrations from API documentation rather than step-by-step instructions |
| 3 | **Workflow Architecture** | Decompose automation systems into maintainable workflows and reusable components |
| 4 | **Logic & State** | Design decision paths, fallbacks, duplicate prevention, and state-aware processing |
| 5 | **Reliability** | Design retries, error paths, validation, recovery, and observable failure behaviour |
| 6 | **Troubleshooting** | Diagnose workflows the candidate did not originally build |
| 7 | **AI Automation** | Use AI selectively inside controlled workflows, with validation and deterministic safeguards |

**Documentation and communication are assessed within every domain,** not as a separate subject. A candidate who cannot explain a design has not demonstrated the domain.

### 4.3 Assessment components

| Part | Component | Weight | Delivery |
|---|---|---|---|
| 1 | Knowledge & Scenario Judgment | 20% | Timed, written. Judgment scenarios, not definitions. |
| 2 | Practical Build Challenge | 35% | Business requirement, unseen. Candidate chooses the approach. |
| 3 | Troubleshooting Challenge | 30% | Live, timeboxed, supervised. Workflow the candidate did not build. |
| 4 | Architecture Walkthrough | 15% | Live, 5–10 minutes plus follow-up questions. |

### 4.4 Domain-to-component coverage

Every domain must be evidenced by at least two components. This prevents gaps and prevents any single domain being judged on one artifact.

| Domain | Part 1 | Part 2 | Part 3 | Part 4 |
|---|:---:|:---:|:---:|:---:|
| 1. Data Engineering | ● | ● | ● | |
| 2. Integrations & APIs | ● | ● | ● | ● |
| 3. Workflow Architecture | ● | ● | | ● |
| 4. Logic & State | ● | ● | ● | ● |
| 5. Reliability | ● | ● | ● | ● |
| 6. Troubleshooting | ● | | ● | ● |
| 7. AI Automation | ● | ● | ● | ● |

### 4.5 Part 2 — Practical Build Challenge

The candidate receives a business requirement they have not previously built. **No node-level instructions are given.** The assessment is whether they can translate a business requirement into an automation design.

Reference scenario shape (rotated each attempt): a service company receives work requests containing customer name, email, service type, priority, location, and description. The system must validate required information, normalise input, look up external information through an API, route the request, prevent duplicate processing, store the result, handle API failure, and produce a final notification.

### 4.6 Part 3 — Troubleshooting Challenge

The candidate receives a workflow they did not build, with the instruction: *this workflow has been producing inconsistent results. Investigate it and produce a corrected version plus a short diagnostic report.*

**The number of defects is not disclosed.** The task is to determine whether the system is behaving correctly — not to find a stated quantity of bugs.

Defect bank (a rotating subset is seeded per attempt):

- a field renamed upstream but still referenced downstream
- wrong IF operator (contains where equals is required, or the reverse)
- missing fallback route on a Switch
- duplicate insert with no idempotency guard
- retry configured on a permanent 4xx error
- a branch that never reconnects to the output path
- malformed AI structured output passed downstream unvalidated
- missing-data path allowed to continue rather than stop
- API result trusted without validation
- silent partial failure: fewer records leave than entered

All troubleshooting workflows run on pinned or sandboxed data. **No candidate spends assessment time configuring credentials.**

### 4.7 Part 4 — Architecture Walkthrough

Five to ten minutes, plus assessor follow-up. The candidate covers: the problem solved, the design, major data structures, where decisions occur, what can fail, what happens when it fails, how duplicate processing is prevented, what they would monitor, and why they chose this design over alternatives.

**This component also serves as authorship verification.** A candidate who cannot answer follow-up questions about their own submission has not demonstrated the competency, regardless of the artifact's quality. This is stated to candidates in advance.

### 4.8 Passing standard — provisional

Thresholds for the first assessment cycle are **provisional** and will be confirmed after calibration (Section 9).

| Requirement | Provisional threshold |
|---|---|
| Overall score | 75% |
| Part 2 — Practical Build | 70% minimum |
| Part 3 — Troubleshooting | 70% minimum |
| No domain below | 50% |

Minimum scores on Parts 2 and 3 are **non-compensatory**. Strong theory cannot offset weak hands-on ability. A candidate who cannot diagnose an unfamiliar fault does not hold this certification.

### 4.9 Critical safety failures

Certain outcomes trigger **Remediation Required** regardless of overall score:

- exposing credentials, API keys, or tokens in any submitted artifact;
- sending sensitive or unnecessary personal data to an AI provider;
- deleting or modifying production-like data without appropriate safeguards;
- designing a workflow that silently discards failed records;
- leaving a critical action entirely dependent on unvalidated AI output.

These are professional standards, not scoring criteria. They are published to candidates before assessment.

### 4.10 Outcomes

| Outcome | Meaning |
|---|---|
| **Certified** | Met all requirements. Credential issued. |
| **Assessment Not Yet Passed** | Did not reach the standard. Written feedback issued. May reattempt. |
| **Remediation Required** | One or more specific competency gaps, or a critical safety failure. Named gaps must be addressed and evidenced before a further attempt. |

The term "failed candidate" is not used. The assessment measures whether the standard has been reached *yet*.

### 4.11 Retake policy

- First reattempt: minimum 7-day wait.
- Second reattempt: minimum 30-day wait.
- Third and subsequent: at assessor discretion, following a remediation plan.
- **Every attempt uses a different practical scenario and a different seeded troubleshooting workflow.**

### 4.12 Entry routes

**Path A — Training route**
Foundations Certificate → Intermediate Cohort → BCAB Assessment → Certified

**Path B — Experience route**
Working automation practitioner → Readiness Assessment → BCAB Assessment → Certified

Path B candidates are not required to purchase training. A readiness assessment establishes that an attempt is realistic; it is advisory, not a gate, and its fee is credited against the assessment fee.

Path B is essential to the credential's independence and is to be maintained even when it is commercially inconvenient.

---

## 5. Stage 3 — Bulletproof Certified Automation Engineer (BCAE)

Defined now for pathway clarity; **not to be issued until its standard and assessment are written.**

Reserved scope: architecture, databases, advanced integrations, security, secrets management, environments, deployment, version control, CI/CD, queue-based processing, scaling, concurrency, observability, recovery, operational ownership, AI governance, human approvals, permissions, production documentation, and system lifecycle management.

At this level the platform is the implementation detail, not the subject.

---

## 6. Assessment integrity

**Assessor record.** Every component is scored per domain with a one-line written justification. The record is retained and forms the basis of any appeal.

**Second review.** Mandatory for: any result within 5 percentage points of a threshold, any Remediation Required outcome, and any candidate taught by the assessing assessor.

**Conflict of interest — teaching.** Where the assessor also taught the candidate, second review applies to all outcomes, not only borderline ones.

**Conflict of interest — hiring.** See Section 7.

**Calibration.** Where more than one assessor is active, both independently score the same two submissions each cycle and reconcile before results are issued.

**Authorship.** Part 4 verifies that submitted work is the candidate's own. Parts 1 and 2 are not assumed to be unaided; the live components carry the integrity weight, and this is stated to candidates openly rather than policed covertly.

**Appeals.** Within 14 days, reviewed by an assessor not involved in the original decision.

**Revocation.** For misrepresentation of the credential, or submitted work later shown not to be the candidate's own.

---

## 7. Use as a hiring standard

Bulletproof Automations uses BCAB as a minimum competency standard for automation roles. This is published, because a credential with a real consumer is worth more than one without.

Three controls apply:

1. **Separation of decisions.** Certification outcomes are determined solely against this framework. Hiring interest, or its absence, is not a factor in any assessment decision and is not discussed with the assessor before an outcome is issued.

2. **No implied employment.** Certification is not an offer, promise, or indication of employment. No marketing material for the pathway may suggest that certification leads to work at Bulletproof Automations. Required wording: *"BCAB is a minimum standard for automation roles at Bulletproof Automations. Holding it does not constitute an application, offer, or guarantee of employment."*

3. **Documented basis.** Because outcomes may affect employment prospects, the per-domain score record, second review, and appeals route in Section 6 apply without exception.

---

## 8. Credential issuance and validity

| Element | Standard |
|---|---|
| Credential ID | Unique, non-sequential, issued per credential |
| Verification | Public page: holder name, credential, issue date, platform version, current status |
| Platform version | Recorded on the credential (e.g. "assessed against n8n 1.x") |
| Validity — Foundations Certificate | Does not expire (it records completion of training on a date) |
| Validity — BCAB | 24 months |
| Recertification | Submit one current workflow demonstrating continued practice, plus a short update assessment covering platform change since issue |
| Permitted description | Supplied with each credential; holders may not describe it as an n8n certification |

---

## 9. Provisional standards and calibration

The thresholds in 4.8 are set before any candidate has been assessed and are therefore **provisional**.

**Calibration protocol:**

1. Assess cohort one against the provisional thresholds.
2. Record the full score distribution per component and per domain.
3. Review: item-level performance in Part 1, score spread in Parts 2 and 3, and any component where nearly all candidates cluster at one end (a sign the instrument, not the candidates, needs work).
4. Confirm or revise thresholds and publish them as Version 3.0 with the reasoning.
5. Candidates assessed under provisional thresholds are not disadvantaged by any subsequent increase; results stand as issued.

This is stated publicly. Standard-setting after piloting is normal practice and is a credibility asset, not a weakness.

---

## 10. Outcome tracking

Recorded from cohort one, with holder consent:

- numbers assessed, certified, not yet passed, and remediation required — per cycle, published annually;
- portfolio links, where holders permit publication;
- self-reported outcomes at 6 and 18 months (paid automation work, role change, projects shipped).

This record is the primary long-term asset of the programme. It is built from the outset rather than reconstructed later.

---

## 11. Independence statement

Bulletproof Automations is an independent training and certification provider. This framework and the credentials issued under it are not affiliated with, endorsed by, or accredited by n8n GmbH or any other vendor. "n8n" is referenced descriptively as the platform on which competence is currently assessed. Vendor certifications are held separately and additionally.

---

## Revision history

| Version | Date | Change | Author |
|---|---|---|---|
| 1.0 | [DATE] | Initial draft | J. Lightfoot |
| 2.0 | [DATE] | Certificate/certification split; seven domains; four assessment components; provisional thresholds; hiring-standard governance | J. Lightfoot |

---

## Open decisions before publication

- [ ] Assessment fee (BCAB) and readiness assessment fee (Path B)
- [ ] Verification page host and format
- [ ] Second assessor identified and calibrated before cohort one concludes
- [ ] Scenario bank: two practical scenarios and two seeded troubleshooting workflows built and tested before launch; third in reserve
- [ ] Part 1 item bank written and reviewed for judgment-based (not recall-based) phrasing
- [ ] Foundations attendance minimum defined numerically
- [ ] Legal review of hiring-standard wording in Section 7

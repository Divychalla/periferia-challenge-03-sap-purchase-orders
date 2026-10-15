# SOLUTION — Challenge 03: SAP Purchase Orders

## 1. Problem

Administrative analysts spend time re-keying purchase requests into SAP and checking approver, supplier and amount controls by memory; this solution prepares a traceable order and flags exceptions for their decision.

## 2. Architecture

```text
Browser chat (`web/`)
       │ POST /api/chat
       ▼
Node HTTP API + bounded agent loop (`src/server.ts`, `src/agent/`)
       ├── OpenAI Chat Completions adapter (`src/llm/`) when configured
       ├── Prompt (`agent/prompt.md`) + process knowledge (`src/knowledge/`)
       ▼
Zod tools (`src/tools/po.ts`)
       ├── read-only fixtures (`fixtures/challenge-03/`)
       └── file SAP adapter (`src/sap/`) → `out/`
```

The tools own data access and control outcomes. The LLM may ask for operations and explain their results, but it cannot supply the validated amounts, supplier, approver or PO number. With no API key, the same tools are exercised through a deterministic local chat workflow.

## 3. Agent loop and confirmation

With `OPENAI_API_KEY`, the server passes the prompt, process knowledge and Zod-derived function schemas to the OpenAI adapter. It runs at most `MAX_TOOL_ITERATIONS` tool/model rounds per turn (default 10), validates each tool argument, returns tool results to the model and exposes every call in the chat. The API estimates tokens from serialized message size and enforces `MAX_SESSION_TOKENS` (default 30,000) plus a server-process-wide `MAX_TOTAL_TOKENS` estimate (default 120,000); provider calls time out after 30 seconds. The server-wide estimate resets when the process restarts and should be paired with host-level spend alerts in production.

Validation blockers stop creation. Confirmations are stored by the server after a successful `po_validate`; the next user turn must be an explicit affirmative response. The UI highlights the pause and provides confirm/cancel actions. The server consumes that confirmation on the immediately following message, and `po_create` independently re-runs the controls. Tool arguments cannot grant confirmation. Successful, blocked and pending attempts are recorded in `out/control.csv`.

## 4. Model and estimated cost

The adapter defaults to OpenAI `gpt-5.4-mini`, chosen for low-latency tool-calling workflows. The deployment can select another compatible OpenAI model with `OPENAI_MODEL`; model interaction is optional for local fixture review. The current listed standard rates are $0.75 per million input tokens and $4.50 per million output tokens ([model page](https://developers.openai.com/api/docs/models/gpt-5.4-mini)). At an assumed 15,000 input and 2,000 output tokens for a complete case, the estimate is about $0.02 per case. Actual use depends on tool-call count and conversation history; the session cap limits consumption.

## 5. Control matrix

| Rule | Implementation | Case signal |
|---|---|---|
| RC1 supplier exists and active | Match by normalized tax ID, otherwise normalized name; inactive/missing is a blocker | `req-002` blocked |
| RC2 approval wording and authorized sender | Requires “Approved” and an approver email listed for the request cost center | `req-003` blocked |
| RC3 approval limit | Compare request total with the matching approver's cost-center limit | Validated on each request |
| RC4 valid subarea | Exact case-insensitive membership in cost-center subareas | Validated on each request |
| RC5 quote variance ≤ 2% | Compare normalized quote total; no quote or >2% creates a confirmation | `req-004` confirmation |
| RC6 missing tax code | Derive supplier default and ask; unknown codes block | `req-006` confirmation |
| RC7 missing payment terms | Derive and report supplier default; validate it against the payment-term master | Exposed in derived values |
| RC8 retroactive invoice | Invoice date earlier than request date sets `retroactive` and requires confirmation | `req-005` confirmation |
| RC9 approval before request | Adds a confirmation when approval date is earlier than request date | Validated on each request |
| RC10 amount arithmetic | Block when `quantity × unit_price` differs from total by more than one currency unit | Validated on each request |

The hardest control is RC2: an approval can contain the expected word and still be unauthorized for that cost center. The sender is matched against the selected center's approver list, and that same match supplies the RC3 limit.

## 6. Real SAP adapter design

I would first validate feasibility with the SAP owner, then prefer SAP Integration Suite as the boundary if it is already operated by the company; it centralizes connectivity, credentials, retries and mapping while avoiding direct SAP credentials in this small web service. If Suite is unavailable and the target supports it, use `API_PURCHASEORDER_PROCESS_SRV` OData. Map company code, purchasing organization, supplier, currency and payment terms to the header; map short text, quantity/unit, price, tax, cost center and subarea to item/account-assignment fields; attach approval evidence through the approved document service or a governed reference.

Use OAuth/client credentials or the approved SAP technical-user mechanism from a managed secret store. Never expose credentials to the browser, prompt or logs. Use the request ID as an external reference and check for an existing order before create; if supported, enforce uniqueness at the integration boundary. On timeout, query by that reference before retrying. A partial SAP error remains pending for human review, is captured with a correlation ID and is not retried blindly. If connectivity is not feasible, export the validated payload as an SAP-ready CSV or review sheet for an analyst to paste/upload manually, while preserving the same evidence and control ledger.

## 7. Process reading: retroactive orders

The fixture for `req-005` shows an invoice dated before the request. That is a control signal: procurement authorization is happening after a commitment or delivery, so the order record cannot demonstrate that the expense was approved before purchase. The tool flags this as `retroactive = true`, requires an explicit analyst confirmation, and records the flag in the control ledger. It does not silently reject the case because the brief asks the team to measure and govern this deviation rather than impose a new policy.

Management should establish one clear rule: no order is created after invoice receipt without a named exception reason and an approver with authority for that exception. Track the retroactive rate by cost center, requester and supplier each month; review recurring causes rather than treating each record as an isolated clerical miss. A practical process change is to require a request ID before a supplier commitment, with the request, quote and approval captured together. For urgent purchases, define an emergency path with a short approval SLA and a coded exception reason. Finance can then distinguish genuine emergencies from routine late paperwork and act on trends. The policy owner must decide whether repeated retroactive orders trigger escalation or a hard block.

## 8. Decisions and trade-offs

1. **File-backed SAP mock.** A database would add operational setup and hide the required sequential/idempotent behavior. Flat JSONL and CSV are inspectable and match the fixture scale; production needs concurrency protection and durable storage.
2. **Deterministic fallback plus optional LLM.** A mandatory API key would make the public demo unavailable without provider credentials. The same control tools run locally without a model, while the adapter preserves the required model-driven path. The fallback handles fixture request processing, not open-ended language understanding.
3. **Text approval evidence (P0).** The brief makes PDF P1. Plain text allows a dependency-light, reproducible artifact with identical content and hash; a production deployment can render a PDF after audit approves its template.
4. **Conservative confirmation gate.** Tool arguments such as `confirmed: true` are not trusted. The server requires an affirmative next user message, which can add one interaction but prevents the model from authorizing its own exception.

## 9. Assumptions

- I selected the English `challenge-03` PRD and fixture folder from `challenge-ia-periferia-it.zip`; the Spanish bundle and PDF use older path/name variants for the same challenge. Only Challenge 3 content is included here.
- Fixtures are the normalized source of truth; this implementation does not parse binary Excel/PDF documents.
- Missing invoice fixture means no invoice was supplied, not a malformed invoice.
- `EA` is used as the order unit because request fixtures do not include a unit field.
- `chat-user` identifies a confirmed exception in the simulated payload; production must bind the identity to authenticated analyst records.
- Payment terms supplied by the request are retained; missing values come from the supplier master.

## 10. Coverage and production gaps

| Story | Status | Remaining for production |
|---|---|---|
| US-1 Read package | Done | Parse real `.xlsx`, `.pdf` and email files |
| US-2 Validate controls | Done for fixture rules | Master-data freshness, currency rounding and policy ownership |
| US-3 Build traceable payload | Done | Confirm SAP-specific item/account-assignment mapping |
| US-4 Approval evidence | Done (P0 text + hash) | PDF rendering and records-retention approval |
| US-5 Simulated SAP create | Done | Real adapter, transactional idempotency and concurrency controls |
| US-6 Readable errors | Done for tool and API paths | Centralized monitoring and operational alerts |
| Chat/API/visible tool calls | Done | Persistent sessions, authentication, rate limiting and public hosting |
| Reusable module bonus | Included | Package validation in the target agent platform |

## 11. Use of AI

I used OpenAI Codex (GPT-6) in this task to inspect the challenge materials, select Challenge 3, design and implement the TypeScript tools, agent loop, chat UI, documentation and model-free demo, and review code paths. No other AI assistant was used. I kept a deterministic no-key workflow alongside the LLM adapter because credentials and hosting were not included; this keeps the fixture behaviors reviewable without making a live provider call.

## 12. Risks and mitigations

- **Fixture-only ingestion:** real attachment parsing may misread amounts or dates. Add format-specific parsers, confidence thresholds and a human review screen before production.
- **Master data drift:** supplier or approval changes can invalidate an order. Query an authoritative system at decision time and record its version/timestamp.
- **Concurrent file writes:** JSONL sequence allocation is not atomic across instances. Use a transactional database or an idempotency constraint in the integration layer.
- **Model/provider failure:** use the deterministic tool workflow, bounded retries and clear errors; the model never becomes the source of transaction facts.
- **Public deployment exposure:** the demo has no authentication as allowed by the brief. Before any non-fixture data is used, add authentication, rate limits, origin controls and secret management.
- **Confirmation identity:** the fixture prototype knows only that the next message came from the chat. Production must authenticate the analyst and retain a signed approval/audit record.

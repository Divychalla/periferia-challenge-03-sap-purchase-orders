# Purchase order process knowledge

The analyst works from a request package containing the request, supplier quote and approval email. Fixture files represent normalized attachments. The agent reads the package, validates it against the supplied master data, shows a traceable SAP-shaped draft and generates an approval evidence text file. It does not connect to real SAP.

## Controls

- A supplier must be present and active in the supplier master. Match by tax ID when supplied; otherwise use a normalized supplier name.
- The approval must contain the word “Approved” and come from an approver assigned to the request's cost center. The request amount must not exceed that approver's limit.
- The subarea must belong to the selected cost center.
- Quote and request totals may differ by at most 2%. A missing quote or larger variance needs analyst confirmation.
- If tax code is missing, derive the supplier default and ask for confirmation. If payment terms are missing, derive the supplier default and report it.
- An invoice dated before the request is retroactive and requires confirmation. Approval dated before the request also requires confirmation.
- Quantity times unit price must match the request total within one currency unit.
- Blockers prevent creation. Confirmations permit creation only after an explicit affirmative response in the immediately preceding chat turn.

## Human review

The analyst owns the decision to proceed with exceptions. The model cannot grant its own confirmation, change source values or bypass a blocker. The simulated adapter is idempotent on the request identifier, and all attempts are written to the control CSV.

# Ledgerhand

## Phase 6 operator console

The console's live view is a 2 fps screenshot poll with coordinate input forwarding, not a real co-browsing stack. The control-transfer model is real: the automation and human share one BrowserSession, one BrowserContext, one live page and its cookies; control has an explicit holder and lease, human actions are recorded, and checkpoint-based resume decides whether to advance or re-run.

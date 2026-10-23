# Chat Provider Concurrency and Failure Clarity

## Finding

The relay provider returns HTTP 429 when more than one request uses the same account. Easel previously serialized work by conversation only, so runs from separate conversations could overlap on one provider. The provider rejected the overlap, while the saved run used a generic execution error that did not explain the cause.

## Change

- Serialize chat runs by provider both inside the web process and across Easel processes. Distinct providers can continue concurrently.
- Show when a run is queued. Users can stop it before it reaches the provider; if the queue remains busy for five minutes, the run ends with a clear message that it was not sent.
- Explain stored failures as provider concurrency limits only when the saved detail includes both HTTP 429 and an explicit one-request concurrency limit. Other 429 responses keep their original classification.
- Never replay the failed turn automatically. Other applications using the same provider key can still occupy the provider's concurrency slot.

## Verification

`python -m pytest -q tests/test_chat_failure.py tests/test_chat_model_selection.py` passed (49 tests). `node --test tests/chat-navigation-errors.test.mjs` passed (20 tests). Frontend lint and production build passed; lint reported existing warnings in unrelated files, and Vite retained its existing large-chunk warning. `git diff --check` passed. Tests use fake transports and do not call a real model. Host 138 remains on 0.7.4; this source change is not deployed. No installer was built or published.

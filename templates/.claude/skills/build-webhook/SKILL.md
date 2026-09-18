---
name: build-webhook
description: Implements a slice whose trigger is an inbound external event — a webhook — in Rails with dcb_event_store, from a slice.json
---

# Build a webhook slice

> Paths like `app/slices/wallet/...` are the worked example **while it is
> still installed**. INSTALL.md's last step deletes it; the permanent copy
> lives at `.build-kit/examples/wallet/` (`slice/` mirrors
> `app/slices/wallet/`, `spec/` mirrors `spec/slices/wallet/`). Read
> whichever is present.

> Before anything else, read the definition at
> `.build-kit/.slices/{Context}/{slice}/slice.json`. Never invent fields
> that aren't there.

> And read `.build-kit/CLAUDE.md`. The tag rule and the `pii` rules apply
> here exactly as in any other write slice.

---

## When it's this shape and not an automation

The difference isn't "there's an external system": it's **who starts**.

| | who starts | signal in `slice.json` |
|---|---|---|
| **Automation** | us, polling a TODO queue | `processors[]` non-empty |
| **Webhook** | the external system, whenever it likes | an `events[]` element with **`context: "EXTERNAL"`** |

`Element.context` is a per-element field (not the slice-level `context`,
which names the bounded context) — a better signal than parsing
`description` prose for who-starts language, though the prose still carries
the rest of the slice's rules and is worth reading in full.

---

## Step 0 — Does this need a domain rejection?

In this stack every write already goes through a command class, so — unlike
stacks where "record what arrived" has its own separate mechanism — both
answers use the same shape. The question still decides what the command
*contains*:

- **`specifications[]` includes a `SPEC_ERROR` scenario** (some inbound
  bodies are rejected for a domain reason, not just a bad signature) →
  the command folds a decision model and rejects per
  `/build-state-change`, condition and all.
- **A pure "record what arrived" fact** (provenance, a mirrored upstream
  stream) → the command validates input shape only and appends without a
  condition — say so in its class comment.

**If you can't tell which from `slice.json`, invoke `request-feedback`** —
the two produce different behaviour when the provider sends something the
domain should refuse.

---

## Step 1 — The domain shape

Build the command + event with `/build-state-change`'s own Steps 2–4 —
field translation, tags from `idAttribute`, `pii` rules, generated fields
all apply unchanged. This skill only covers the web layer in front of it.

---

## Step 2 — The translation, and which way it points

**Our domain fact leads and the webhook body fills it in**, not the other
way round:

- **One event.** No `WebhookReceived` alongside the business fact.
- **The raw body travels as a technical attribute** (`raw_body`,
  `technicalAttribute: true`) — forensics only; never a tag, never folded.
- **Field names are domain names**, not the provider's.
- **The translation is a pure method**, separate from the controller:
  `<Context>::<Translator>.to_domain(raw_body) -> Result` (failure for a
  body that doesn't parse/validate) — the one part of a webhook that
  really deserves its own unit specs.

---

## Step 3 — The route and the signature check

**Files:** `app/slices/<context>/web/<provider>_webhooks_controller.rb`,
one `post` line in `config/routes.rb` (with `module: :<context>` — the
controller is namespaced).

```ruby
module <Context>
  class <Provider>WebhooksController < ApplicationController
    # Providers can't send CSRF tokens; the signature is the auth.
    skip_before_action :verify_authenticity_token

    def create
      raw = request.raw_post
      return head :unauthorized unless valid_signature?(raw)

      translated = <Translator>.to_domain(raw)
      return head :unprocessable_entity if translated.failure?

      result = <Command>.call(**translated.value)
      # A domain rejection is OUR answer, not the provider's failure:
      # 200 with no retry expected, unless the board says otherwise.
      head result.success? ? :ok : :ok
    end

    private

    def valid_signature?(raw)
      secret = Rails.application.credentials.dig(:<provider>, :webhook_secret) ||
               ENV["<PROVIDER>_WEBHOOK_SECRET"]
      return false if secret.nil?

      given = request.headers["X-<Provider>-Signature"].to_s
      expected = OpenSSL::HMAC.hexdigest("SHA256", secret, raw)
      ActiveSupport::SecurityUtils.secure_compare(expected, given)
    rescue ArgumentError
      false
    end
  end
end
```

Rules:

- **Verify against the raw bytes** (`request.raw_post`), before parsing —
  never against re-serialized JSON.
- **`secure_compare`**, never `==`, for the signature.
- **Missing secret → 401 and a log line**, never a crash and never
  accepting unsigned.
- **Status codes are the provider's retry contract** — check the
  provider's documented semantics; the sketch above (200 even on domain
  rejection, 401 on bad signature, 422 on unparseable) is the common
  default. If the board's description names the provider, follow its docs;
  if retry semantics matter and aren't derivable, `request-feedback`.

### OpenAPI

Register the inbound endpoint under `<Context>::Openapi.webhooks` (OpenAPI
3.1's top-level `webhooks` section — `lib/open_api.rb` merges it), **not**
under `.paths`: it documents what the provider sends us, the raw-body
requirement and the status-code contract from Step 3. If the context
directory is new, it also needs its `package.yml`
(copy `app/slices/wallet/package.yml`).

### Redelivery

Providers redeliver. Whether the same delivery twice is a safe no-op is
`/build-state-change`'s "idempotent caller retries" decision — if the
provider sends a delivery/event id, that's the natural identity to check
in the command's decision model. If the board models nothing and
double-recording would matter, `request-feedback`.

---

## Step 4 — Specs

- `to_domain`: pure unit specs — a valid body maps (domain names, literal
  board examples), an invalid one returns failure. Fixture bodies come
  from the provider's documented examples, not invented.
- The command: per `/build-state-change` (including redelivery if
  modelled).
- Request specs for the controller: valid signature + valid body → ok +
  event appended; bad signature → unauthorized + **nothing appended**;
  unparseable body → unprocessable + nothing appended.

---

## Step 5 — Quality gate

```
bundle exec rspec && bundle exec rubocop && bundle exec packwerk check
bundle exec rspec spec/slices/<context_snake_case>
```

---

## Final check against `slice.json`

- [ ] Step 0's rejection question answered from `specifications[]` (or
      escalated).
- [ ] One domain event; raw body as `technicalAttribute`; domain field
      names; tags from `idAttribute`.
- [ ] Signature verified on raw bytes with `secure_compare`; missing
      secret fails closed.
- [ ] Bad signature/body appends nothing (request specs prove it).
- [ ] Redelivery semantics settled (modelled, or escalated).
- [ ] Status codes match the provider's retry contract.
- [ ] The endpoint is documented under `web/openapi.rb`'s `.webhooks`.

# Screen: Wallet balance

Slice `slice: wallet balance` · worked example shipped by the kit — read it
for how much detail a screen brief is worth, then delete it once you have
your own. (This particular screen was simple enough that the kit's worked
example *also* builds it — `app/slices/wallet/views/wallets/show.html.erb` —
so this brief doubles as the record of what that view may rely on.)

## How it's entered

`GET /wallets/:wallet_id` → `Wallet::WalletsController#show`, which folds
`Wallet::Balance.find(wallet_id:)` on demand. No caching, no materialized
row — the fold runs per request.

## What it returns

| field | type | | what it is |
|---|---|---|---|
| `balance_cents` | Integer | | sum of Deposited minus Withdrawn for this wallet's tag, in cents |

A wallet with no events folds to `0` — that renders as a zero balance,
never as an error or a 404.

## What it sends back

- `POST /wallets/:wallet_id/deposit` with `amount_cents` — rejections the
  screen must translate: `"wallet is required"`,
  `"amount must be a positive number of cents"`.
- `POST /wallets/:wallet_id/withdraw` with `amount_cents` — additionally:
  `"wallet is overdrawn"`,
  `"the wallet changed while you were working — please retry"`.

## States to render

Empty (balance 0), normal, and the flash-alert state after a rejected
command. Reads are read-your-writes: the fold runs at request time against
the store, so a just-completed deposit is always visible on the redirect.

## What the board says about this screen

> Show the current balance and let the owner deposit or withdraw.

## What the domain does NOT give you

- No transaction history list — only the folded balance. A history view is
  its own read-model slice; don't fake it from this one.
- No currency — amounts are integer cents with no denomination field, by
  the board's own model. If a currency is ever needed it's a board change,
  not a view-side default.

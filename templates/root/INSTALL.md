# Installing the framework

Rails apps are scaffolded by `rails new`, so unlike kits whose
`templates/root/` is already a runnable project, this kit is an **overlay**.
Order matters: `rails new` **first**, then
`npx @eventmodelers/cli init --stack rails-dcb --git <this repo>` inside it
(the CLI copies this overlay on top and never deletes what `rails new`
wrote).

**This file is meant to be read, followed, and deleted.**

## 0 · Prerequisites

Ruby ≥ 3.3, Node not required. **No database server**: the event store
defaults to SQLite — one file under `storage/`, created for you in step 5.
(PostgreSQL is one env var away — see *Using PostgreSQL instead* at the
bottom.)

## 1 · `rails new` (if you haven't yet)

```bash
rails new my_app --skip-active-record --skip-action-mailbox --skip-action-text \
  --skip-active-storage --skip-test --skip-system-test
cd my_app
```

`--skip-active-record` is the important one — the only persistence in this
stack is the append-only events table, reached through `lib/event_store.rb`.
It skips `config/database.yml` and ActiveRecord entirely; the event store's
own SQLite file is configured in `config/event_store.yml`, not there.

If you pass `--skip-git`, Rails writes **no `.gitignore`** — this kit ships
one (it covers `config/master.key`, `storage/`, `*.sqlite3`, `node_modules/`).
Before your first commit, check it landed and that `git status` does not show
`config/master.key`.

Then run the kit installer inside the app directory (skip if you already
did — this INSTALL.md arriving means it ran):

```bash
npx @eventmodelers/cli init --stack rails-dcb --git https://github.com/kjeldahl/evm-rails-dcb-toolkit
```

## 2 · Gemfile

The CLI copies files without merging, so it can't edit the `Gemfile`
`rails new` generated. Append:

```ruby
# Event sourcing via Dynamic Consistency Boundary event store
gem "dcb_event_store", github: "Kjeldahl/ruby-dcb"
gem "sqlite3", "~> 2.0"
gem "connection_pool", "~> 2.4"

# Environment pin, not a kit requirement: json 3.x breaks Rails' JSON request
# parsing (seen on Ruby 4.0.5), so the curl calls below fail on a well-formed
# body. Drop the pin once your Ruby/Rails pair is known good with json 3.
gem "json", "~> 2.10"

group :development, :test do
  gem "rspec-rails", "~> 8.0"
  gem "rubocop-rails-omakase", require: false

  # Quality gate: slice boundary enforcement (no cross-slice constant refs)
  gem "packwerk", require: false
  # packwerk requires benchmark, no longer a default gem on newer Rubies
  gem "benchmark", require: false
end
```

```bash
bundle install
bin/rails generate rspec:install
```

Then make RSpec load the kit's support files — in `spec/rails_helper.rb`,
uncomment (or add):

```ruby
Rails.root.glob("spec/support/**/*.rb").sort_by(&:to_s).each { |f| require f }
```

## 3 · Wire the slices into `config/application.rb`

Paste inside `class Application < Rails::Application`:

```ruby
# Vertical slices: each directory under app/slices is a self-contained
# bounded context namespaced by its directory name (Wallet, ...). The
# domain/ and web/ subdirectories are collapsed so they organise files
# without adding namespace depth: app/slices/wallet/domain/deposit.rb
# defines Wallet::Deposit.
slices_root = root.join("app/slices")
config.autoload_paths << slices_root
config.eager_load_paths << slices_root
initializer "app.collapse_slice_dirs", before: :setup_main_autoloader do
  Rails.autoloaders.main.collapse(slices_root.join("*/domain"))
  Rails.autoloaders.main.collapse(slices_root.join("*/web"))
end
# Each slice's views/ is a view-lookup root, so app/slices/wallet/views/
# wallets/show.html.erb is found as "wallets/show" (see step 4).
config.paths["app/views"].concat(root.glob("app/slices/*/views").map(&:to_s))
```

## 4 · `app/controllers/application_controller.rb`

Two lines of policy every slice depends on. Paste inside
`class ApplicationController < ActionController::Base`:

```ruby
# Slice controllers are namespaced (Wallet::WalletsController) but their
# templates live at app/slices/<slice>/views/<resource>/ — without the
# namespace segment. Rails' default lookup prefix is the full controller
# path ("wallet/wallets"), which finds nothing and renders 204 No Content;
# the last segment is the one that matches. Resource directory names must
# therefore be unique across slices — they share one lookup path.
def self.local_prefixes
  [ controller_path.split("/").last ]
end

# The JSON API is stateless and token-less (see each slice's web/openapi.rb),
# so a `curl -d '{...}'` call carries no CSRF token and would be rejected
# with 422. HTML form posts keep full forgery protection.
protect_from_forgery with: :exception, unless: -> { request.format.json? }
```

Both failures are silent if you skip this — a namespaced controller's template
is simply never found (204 No Content, no error) and JSON calls 422 — so
`spec/controllers/application_controller_spec.rb` asserts them. It stays after
the worked example is deleted.

## 5 · Event store

Connection settings live in `config/event_store.yml` (env-overridable:
`EVENT_STORE_ADAPTER`, `EVENT_STORE_PATH`, and the PostgreSQL
`EVENT_STORE_HOST/PORT/USER/PASSWORD/DATABASE`). Defaults to SQLite at
`storage/<env>.sqlite3`. Create the file and the schema:

```bash
bin/rails event_store:prepare   # creates storage/ if missing, then the events tables
```

(`event_store:setup` = schema only; `event_store:reset` = drop + recreate,
destroys all events.)

## 6 · Routes

Paste into `config/routes.rb` — the OpenAPI endpoint (permanent) and the
worked example's routes (deleted with the example):

```ruby
get "openapi.json" => "openapi#show"

# module: :wallet is required — the controller is Wallet::WalletsController.
# Without it Rails looks up a top-level WalletsController and raises
# "uninitialized constant WalletsController". Every slice's route line needs
# `module: :<slice>`; the path and helper names stay un-namespaced.
resources :wallets, only: :show, param: :wallet_id, module: :wallet do
  member do
    post :deposit
    post :withdraw
  end
end
```

## Done

```bash
bundle exec rspec && bundle exec rubocop && bundle exec packwerk check
bin/rails server
# JSON API + OpenAPI doc:
#   curl -H 'content-type: application/json' -d '{"amount_cents":500}' localhost:3000/wallets/w1/deposit.json
#   curl localhost:3000/wallets/w1.json
#   curl localhost:3000/openapi.json
# HTML screen:
#   open http://localhost:3000/wallets/w1
```

Once green, **delete this file, delete `app/slices/wallet/`,
`spec/slices/wallet/` and the wallet routes** (keep `get "openapi.json"`;
keep a copy of the example reachable via `git show` on this commit — every
`build-*` skill points at the worked example by name), and start marking
slices `Planned` on the board.

## Using PostgreSQL instead

SQLite is the default because it needs no server. PostgreSQL is worth
switching to when appends must proceed in parallel across disjoint
consistency boundaries, when several hosts share the store, or when
subscribers should wake without polling (SQLite subscribers poll).

```ruby
# Gemfile: replace sqlite3 with
gem "pg", "~> 1.5"
```

```bash
createuser -s my_app 2>/dev/null || true   # or point EVENT_STORE_USER at an existing role
EVENT_STORE_ADAPTER=postgres bin/rails event_store:prepare  # creates the database, then the schema
```

Set `EVENT_STORE_ADAPTER=postgres` wherever the app runs (the `database:`,
`host:`, `username:` and `password:` keys in `config/event_store.yml` are
already there, unused by the SQLite adapter). Nothing else changes —
slices, specs and the plumbing are backend-agnostic.

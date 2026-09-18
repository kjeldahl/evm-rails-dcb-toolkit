# Installing the framework

Rails apps are scaffolded by `rails new`, so unlike kits whose
`templates/root/` is already a runnable project, this kit is an **overlay**.
Order matters: `rails new` **first**, then
`npx @eventmodelers/cli init --stack rails-dcb --git <this repo>` inside it
(the CLI copies this overlay on top and never deletes what `rails new`
wrote).

**This file is meant to be read, followed, and deleted.**

## 0 · Prerequisites

Ruby ≥ 3.3, PostgreSQL running locally, Node not required.

## 1 · `rails new` (if you haven't yet)

```bash
rails new my_app --skip-active-record --skip-action-mailbox --skip-action-text \
  --skip-active-storage --skip-test --skip-system-test
cd my_app
```

`--skip-active-record` is the important one — the only persistence in this
stack is the append-only events table, reached through `lib/event_store.rb`.

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
gem "pg", "~> 1.5"
gem "connection_pool", "~> 2.4"

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
config.paths["app/views"].concat(Dir[slices_root.join("*/views")])
```

## 4 · Postgres + event store

Credentials live in `config/event_store.yml` (env-overridable:
`EVENT_STORE_HOST/PORT/USER/PASSWORD/DATABASE`). Create role + database +
schema in one go:

```bash
createuser -s my_app 2>/dev/null || true   # or point EVENT_STORE_USER at an existing role
bin/rails event_store:prepare               # creates the database if missing, then the events table
```

(`event_store:setup` = schema only; `event_store:reset` = drop + recreate,
destroys all events.)

## 5 · Routes

Paste into `config/routes.rb` — the OpenAPI endpoint (permanent) and the
worked example's routes (deleted with the example):

```ruby
get "openapi.json" => "openapi#show"

resources :wallets, only: :show, param: :wallet_id do
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
```

Once green, **delete this file, delete `app/slices/wallet/`,
`spec/slices/wallet/` and the wallet routes** (keep `get "openapi.json"`;
keep a copy of the example reachable via `git show` on this commit — every
`build-*` skill points at the worked example by name), and start marking
slices `Planned` on the board.

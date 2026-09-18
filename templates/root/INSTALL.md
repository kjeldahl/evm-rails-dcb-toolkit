# Installing the framework

Rails apps are scaffolded by `rails new`, so unlike kits whose
`templates/root/` is already a runnable project, this kit is an **overlay**.
Everything `rails new` owns — `Gemfile`, `config/application.rb`,
`ApplicationController`, `config/routes.rb`, `.gitignore`, RSpec — has to be
patched *after* the overlay lands, which is what `template.rb` does.

**This file is meant to be read, followed, and deleted.**

## 0 · Prerequisites

Ruby >= 3.3, Node not required for the app itself. **No database server**:
the event store defaults to SQLite — one file under `storage/`. (PostgreSQL
is one env var away — see *Using PostgreSQL instead* at the bottom.)

## 1 · Install

```bash
rails new my_app --skip-active-record --skip-action-mailbox --skip-action-text \
  --skip-active-storage --skip-test --skip-system-test
cd my_app
npx @eventmodelers/cli init --stack rails-dcb --git https://github.com/kjeldahl/evm-rails-dcb-toolkit
bin/rails app:template LOCATION=https://raw.githubusercontent.com/kjeldahl/evm-rails-dcb-toolkit/main/template.rb
```

**Installed this kit before?** The CLI caches its clone of a `--git` stack in
`~/.eventmodelers/git-stacks/` and reuses it without pulling, so a second
install copies the version you first fetched. Refresh it before `init`:

```bash
rm -rf ~/.eventmodelers/git-stacks/*evm-rails-dcb-toolkit*
# or, in that clone: git -C ~/.eventmodelers/git-stacks/<dir> pull
```

`template.rb` is fetched by URL on every run, so it is never stale — but the
overlay the CLI copies is.

`--skip-active-record` is the important one — the only persistence in this
stack is the append-only events table, reached through `lib/event_store.rb`.
It skips `config/database.yml` and ActiveRecord entirely; the event store's
own SQLite file is configured in `config/event_store.yml`, not there.

The last line is the whole of section 2 below, run for you: gems, the slice
wiring, the two `ApplicationController` policies, the routes, RSpec, the app
name in `config/event_store.yml`, the archived worked example and
`event_store:prepare`. **It is idempotent** — re-run it any time the CLI
copies the overlay again.

Without a board yet, the template can fetch the overlay itself:

```bash
rails new my_app --skip-active-record --skip-action-mailbox --skip-action-text \
  --skip-active-storage --skip-test --skip-system-test \
  -m https://raw.githubusercontent.com/kjeldahl/evm-rails-dcb-toolkit/main/template.rb
```

Then verify:

```bash
bundle exec rspec && bundle exec rubocop && bundle exec packwerk check
bin/rails server
#   curl -H 'content-type: application/json' -d '{"amount_cents":500}' localhost:3000/wallets/w1/deposit.json
#   curl localhost:3000/wallets/w1.json
#   curl localhost:3000/openapi.json
#   open http://localhost:3000/wallets/w1
```

Green? Skip to *Cleanup*.

## 2 · By hand, if you would rather

Everything the template does, in order. Each step says what breaks when it
is skipped — all four failures are silent or misleading.

### Gemfile

```ruby
# Event sourcing via Dynamic Consistency Boundary event store
gem "dcb_event_store", github: "Kjeldahl/ruby-dcb"
gem "sqlite3", "~> 2.0"
gem "connection_pool", "~> 2.4"

# Environment pin, not a kit requirement: json 3.x breaks Rails' JSON request
# parsing (seen on Ruby 4.0.5), so the curl calls above fail on a well-formed
# body. Drop the pin once your Ruby/Rails pair is known good with json 3.
gem "json", "~> 2.10"

group :development, :test do
  gem "rspec-rails", "~> 8.0"

  # Quality gate: slice boundary enforcement (no cross-slice constant refs)
  gem "packwerk", require: false
  # packwerk requires benchmark, no longer a default gem on newer Rubies
  gem "benchmark", require: false
end
```

**`rails new` already put `rubocop-rails-omakase` in the Gemfile** — adding
it again only earns a Bundler warning.

```bash
bundle install
bin/rails generate rspec:install
```

`rspec:install` writes a `rails_helper` for an ActiveRecord app, so in
`spec/rails_helper.rb`: uncomment the support-file glob (nothing resets the
event store between examples without it), comment out
`ActiveRecord::Migration.maintain_test_schema!`, drop `config.fixture_paths`,
and set `config.use_transactional_fixtures = false`.

```ruby
Rails.root.glob("spec/support/**/*.rb").sort_by(&:to_s).each { |f| require f }
```

### `config/application.rb`

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
# wallets/show.html.erb is found as "wallets/show".
config.paths["app/views"].concat(root.glob("app/slices/*/views").map(&:to_s))
```

### `app/controllers/application_controller.rb`

Paste inside `class ApplicationController < ActionController::Base`:

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

Both failures are invisible to a green suite, so
`spec/controllers/application_controller_spec.rb` asserts them, and
`spec/slices/wallet/requests_spec.rb` exercises the whole web path.

### `config/routes.rb`

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

### The rest

```bash
# The overlay is copied, not rendered — and this must catch the PostgreSQL
# database names (my_app_development/_test/_production) too, not just the
# bare "my_app".
ruby -pi -e 'gsub("my_app", "your_app_name")' config/event_store.yml
mkdir -p .build-kit/examples/wallet
cp -r app/slices/wallet .build-kit/examples/wallet/slice
cp -r spec/slices/wallet .build-kit/examples/wallet/spec
bin/rails event_store:prepare     # creates storage/ if missing, then the events tables
```

(`event_store:setup` = schema only; `event_store:reset` = drop + recreate,
destroys all events.)

## Cleanup

Once green, **delete this file, delete `app/slices/wallet/`,
`spec/slices/wallet/` and the wallet routes** (keep `get "openapi.json"`),
then start marking slices `Planned` on the board.

The worked example the `build-*` skills reference by name is **not** lost
with it: `.build-kit/examples/wallet/` holds a permanent copy, outside the
autoload and eager-load paths and excluded from packwerk, so it never boots
with the app.

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
createuser -s your_app_name 2>/dev/null || true   # or point EVENT_STORE_USER at an existing role
EVENT_STORE_ADAPTER=postgres bin/rails event_store:prepare  # creates the database, then the schema
```

Set `EVENT_STORE_ADAPTER=postgres` wherever the app runs (the `database:`,
`host:`, `username:` and `password:` keys in `config/event_store.yml` are
already there, unused by the SQLite adapter). Nothing else changes —
slices, specs and the plumbing are backend-agnostic.

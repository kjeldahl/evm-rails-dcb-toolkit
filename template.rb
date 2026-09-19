# Rails application template for this build kit - the scripted version of
# INSTALL.md. Everything `rails new` owns and the CLI overlay therefore
# cannot touch (Gemfile, config/application.rb, ApplicationController,
# config/routes.rb, .gitignore, RSpec) is patched here, plus the app-name
# substitution in config/event_store.yml that a copied overlay leaves as
# "my_app".
#
# Two ways in:
#
#   # 1 - overlay first (recommended - the CLI also installs the skills and
#   #     the board wiring, and would overwrite event_store.yml afterwards)
#   rails new my_app --skip-active-record --skip-action-mailbox \
#     --skip-action-text --skip-active-storage --skip-test --skip-system-test
#   cd my_app
#   npx @eventmodelers/cli init --stack rails-dcb --git https://github.com/kjeldahl/evm-rails-dcb-toolkit
#   bin/rails app:template LOCATION=https://raw.githubusercontent.com/kjeldahl/evm-rails-dcb-toolkit/main/template.rb
#
#   # 2 - standalone (no board yet): the template fetches the overlay itself
#   rails new my_app --skip-active-record --skip-action-mailbox \
#     --skip-action-text --skip-active-storage --skip-test --skip-system-test \
#     -m https://raw.githubusercontent.com/kjeldahl/evm-rails-dcb-toolkit/main/template.rb
#
# **Every step is idempotent** - re-running it after the CLI copies the
# overlay again is the supported way to repair a half-done install.

require "fileutils"
require "tmpdir"

KIT_REPO = "https://github.com/kjeldahl/evm-rails-dcb-toolkit".freeze

# The dcb_event_store release this kit installs and was tested against.
DCB_VERSION = "0.2.0".freeze

# `rails new -m` runs inside the generator, before `bundle install`, so the
# post-bundle work has to be deferred with after_bundle there. Under
# `bin/rails app:template` the app is already booted and bundled and
# after_bundle callbacks are never run - so the same work runs inline.
BOOTED = defined?(Rails) && Rails.respond_to?(:application) && !Rails.application.nil?

def kit_say(message)
  say_status :kit, message, :green
end

# The app's real name. Under `rails new` the generator's own `app_name` is
# right, but under `bin/rails app:template` it is only the **basename of the
# directory** — often dated or otherwise decorated (a 2026_09_18_… checkout
# becomes a 2026_09_18_…_development database). The constant the app booted
# under is the truth whenever there is a booted app.
def kit_app_name
  BOOTED ? Rails.application.class.module_parent_name.underscore : app_name
end

# --- the overlay ------------------------------------------------------------

def kit_fetch_overlay!
  return kit_say("overlay already present") if File.exist?("config/event_store.yml")

  kit_say "fetching the overlay from #{KIT_REPO}"
  Dir.mktmpdir do |tmp|
    run "git clone --depth 1 --quiet #{KIT_REPO} #{tmp}/kit", capture: true
    FileUtils.cp_r("#{tmp}/kit/templates/root/.", destination_root)
  end
  kit_say "run `npx @eventmodelers/cli init --stack rails-dcb --git #{KIT_REPO}` " \
          "for the build-* skills and the board wiring"
end

# --- Gemfile ----------------------------------------------------------------

def kit_gem?(name)
  File.read("Gemfile").match?(/^\s*gem ["']#{Regexp.escape(name)}["']/)
end

# `rails new` already writes rubocop-rails-omakase into the Gemfile -
# declaring it a second time only earns a Bundler warning.
def kit_gems!
  # Pinned to a released tag, not the moving branch: two installs a week
  # apart otherwise get different gems. Bump the tag to take a new release.
  gem "dcb_event_store", github: "Kjeldahl/ruby-dcb", tag: DCB_VERSION unless kit_gem?("dcb_event_store")
  gem "sqlite3", "~> 2.0" unless kit_gem?("sqlite3")
  gem "connection_pool", "~> 2.4" unless kit_gem?("connection_pool")
  # Environment pin: json 3.x breaks Rails' JSON request parsing (seen on
  # Ruby 4.0.5), which is exactly what this kit's JSON API rides on.
  gem "json", "~> 2.10" unless kit_gem?("json")

  wanted = {
    "rspec-rails" => [ "~> 8.0" ],
    "rubocop-rails-omakase" => [ { require: false } ],
    "packwerk" => [ { require: false } ],
    "benchmark" => [ { require: false } ]
  }.reject { |name, _| kit_gem?(name) }
  return if wanted.empty?

  gem_group :development, :test do
    wanted.each { |name, args| gem name, *args }
  end
end

# --- the files rails new owns ----------------------------------------------

# Each snippet below is applied on its **own** marker. One marker for a
# whole block looks tidier and is wrong on an upgrade: a line added to that
# block in a later version of this kit would never reach an app installed
# before it — which is exactly how `config.time_zone` and the history route
# went missing for one project. Markers anchor at the start of a line, so
# `rails new`'s own commented-out `# config.time_zone = ...` is not mistaken
# for the real setting.

SLICES_WIRING = <<~'WIRING'.freeze
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
WIRING

VIEW_PATHS = <<~'VIEWS'.freeze
  # Each slice's views/ is a view-lookup root, so
  # app/slices/wallet/views/wallets/show.html.erb is found as "wallets/show".
  config.paths["app/views"].concat(root.glob("app/slices/*/views").map(&:to_s))
VIEWS

TIME_ZONE = <<~'ZONE'.freeze
  # Set once, here, because config/ is off-limits to the slice agents: a
  # business rule that needs a local calendar notion (a business day, a
  # cutoff hour) is theirs to raise, not to guess. Domain code uses
  # Time.current and stores iso8601 in UTC.
  config.time_zone = ENV.fetch("APP_TIME_ZONE", "UTC")
ZONE

APP_CONFIG_ADDITIONS = [
  [ /^\s*initializer "app\.collapse_slice_dirs"/, SLICES_WIRING ],
  [ /^\s*config\.paths\["app\/views"\]/, VIEW_PATHS ],
  [ /^\s*config\.time_zone\s*=/, TIME_ZONE ]
].freeze

LOCAL_PREFIXES = <<~'PREFIXES'.freeze
  # Slice controllers are namespaced (Wallet::WalletsController) but their
  # templates live at app/slices/<slice>/views/<resource>/ - without the
  # namespace segment. Rails' default lookup prefix is the full controller
  # path ("wallet/wallets"), which finds nothing and renders 204 No Content;
  # the last segment is the one that matches. Resource directory names must
  # therefore be unique across slices - they share one lookup path.
  def self.local_prefixes
    [ controller_path.split("/").last ]
  end
PREFIXES

FORGERY_POLICY = <<~'FORGERY'.freeze
  # The JSON API is stateless and token-less (see each slice's web/openapi.rb),
  # so a `curl -d '{...}'` call carries no CSRF token and would be rejected
  # with 422. HTML form posts keep full forgery protection.
  protect_from_forgery with: :exception, unless: -> { request.format.json? }
FORGERY

CONTROLLER_ADDITIONS = [
  [ /^\s*def self\.local_prefixes/, LOCAL_PREFIXES ],
  [ /^\s*protect_from_forgery/, FORGERY_POLICY ]
].freeze

OPENAPI_ROUTE = %(get "openapi.json" => "openapi#show"\n).freeze

# module: :wallet is required - the controller is Wallet::WalletsController.
# Without it Rails looks up a top-level WalletsController and raises
# "uninitialized constant WalletsController".
WALLET_ROUTES = <<~'ROUTES'.freeze
  resources :wallets, only: :show, param: :wallet_id, module: :wallet do
    member do
      get :history
      post :deposit
      post :withdraw
    end
  end
ROUTES

def kit_add_to_class!(file, klass, additions)
  additions.each do |marker, snippet|
    next if File.read(file).match?(marker)

    # Trailing newline so successive additions don't run together: each one
    # is injected at the top of the class body, so they stack.
    inject_into_class file, klass, snippet.indent(klass == "Application" ? 4 : 2) + "\n"
  end
end

def kit_patch_app!
  kit_add_to_class! "config/application.rb", "Application", APP_CONFIG_ADDITIONS
  kit_add_to_class! "app/controllers/application_controller.rb", "ApplicationController", CONTROLLER_ADDITIONS
  kit_routes!
end

def kit_routes!
  route OPENAPI_ROUTE unless File.read("config/routes.rb").include?("openapi#show")

  if File.read("config/routes.rb").include?("resources :wallets")
    # Upgrade: the block is already there but may predate a line added to it
    # in a later version of the kit.
    return if File.read("config/routes.rb").match?(/^\s*get :history/)

    inject_into_file "config/routes.rb", "      get :history\n",
                     after: /resources :wallets[^\n]*\n\s*member do\n/, verbose: false
  else
    route WALLET_ROUTES
  end
end

# config/event_store.yml ships with "my_app" in it, because the overlay is
# copied, never rendered. Unanchored on purpose: the PostgreSQL database
# names are my_app_development / _test / _production, and a \b before the
# underscore would leave every one of them behind — the switch to PostgreSQL
# would then silently target someone else's database name.
def kit_name_the_app!
  gsub_file "config/event_store.yml", "my_app", kit_app_name, verbose: false
end

# --- post-bundle ------------------------------------------------------------

# rspec:install writes a rails_helper for an ActiveRecord app; this stack has
# no ActiveRecord at all (--skip-active-record), and its own per-example
# reset lives in spec/support/event_store.rb - which only runs once the
# support glob is uncommented.
RAILS_HELPER_FIXUPS = [
  [ "ActiveRecord::Migration.maintain_test_schema!",
    "# ActiveRecord::Migration.maintain_test_schema! (no ActiveRecord in this stack)" ],
  [ "config.use_transactional_fixtures = true", "config.use_transactional_fixtures = false" ],
  [ "# Rails.root.glob('spec/support/**/*.rb').sort_by(&:to_s).each { |f| require f }",
    "Rails.root.glob('spec/support/**/*.rb').sort_by(&:to_s).each { |f| require f }" ]
].freeze

def kit_rspec!
  rails_command "generate rspec:install" unless File.exist?("spec/rails_helper.rb")
  return unless File.exist?("spec/rails_helper.rb")

  RAILS_HELPER_FIXUPS.each do |from, to|
    gsub_file "spec/rails_helper.rb", from, to, verbose: false
  end
  gsub_file "spec/rails_helper.rb", /^\s*config\.fixture_paths = \[\n.*\n\s*\]\n/, "", verbose: false
end

# The build-* skills point at the worked example by name, but INSTALL.md's
# last step deletes it from the app. Keep a copy outside the autoload and
# eager-load paths so the reference survives the cleanup.
def kit_archive_example!
  return unless Dir.exist?("app/slices/wallet")

  FileUtils.rm_rf(".build-kit/examples/wallet")
  FileUtils.mkdir_p(".build-kit/examples/wallet")
  FileUtils.cp_r("app/slices/wallet/.", ".build-kit/examples/wallet/slice")
  FileUtils.cp_r("spec/slices/wallet/.", ".build-kit/examples/wallet/spec") if Dir.exist?("spec/slices/wallet")
  kit_say "archived the worked example to .build-kit/examples/wallet/"
end

AGENTS_LOCAL = <<~'LOCAL'.freeze
  # Project notes

  What earlier iterations learned about **this** application: its board's
  quirks, decisions taken with `request-feedback`, traps specific to its
  slices.

  The kit never writes this file, so re-installing or upgrading the kit
  cannot erase it. `.build-kit/AGENTS.md` next to it is the kit's own
  starter notes and **is** replaced on every install — never put a project
  learning there.

  Read both before a slice; write new ones here.
LOCAL

# The kit owns .build-kit/AGENTS.md and the CLI overwrites it on every
# install, so anything an agent learns needs a file the kit never writes.
def kit_agents_local!
  return unless Dir.exist?(".build-kit")

  path = ".build-kit/AGENTS.local.md"
  return kit_say("#{path} kept as it is") if File.exist?(path)

  create_file path, AGENTS_LOCAL, verbose: false
  kit_say "created #{path} for this project's own notes"
end

def kit_finish!
  kit_rspec!
  kit_archive_example!
  kit_agents_local!
  rails_command "event_store:prepare"
  kit_say "done - run `bundle exec rspec && bundle exec rubocop && bundle exec packwerk check`, then `bin/rails server`"
end

# --- run --------------------------------------------------------------------

kit_fetch_overlay!
kit_gems!
kit_patch_app!
kit_name_the_app!

if BOOTED
  # `bin/rails app:template` never runs after_bundle callbacks, and the gems
  # this template just added to the Gemfile are not installed yet — anything
  # that shells out to bin/rails below would load a Gemfile it cannot
  # satisfy, so bundle first.
  #
  # And it has to bundle in a *clean* environment. This template runs inside
  # the app's already-booted bundler process, whose BUNDLE_* variables every
  # subprocess inherits; under that environment bundler refuses to resolve
  # the Gemfile at all, because dcb_event_store is a git source it has not
  # checked out yet — `bundle install` and the two bin/rails calls in
  # kit_finish! all die with Bundler::GitError. Nothing raises (Thor reports
  # the failure and carries on), so without this the install finishes
  # "successfully" having written no spec/rails_helper.rb and no event store.
  Bundler.with_unbundled_env do
    run "bundle install"
    kit_finish!
  end
else
  after_bundle { kit_finish! }
end

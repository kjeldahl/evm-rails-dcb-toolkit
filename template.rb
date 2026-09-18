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

# `rails new -m` runs inside the generator, before `bundle install`, so the
# post-bundle work has to be deferred with after_bundle there. Under
# `bin/rails app:template` the app is already booted and bundled and
# after_bundle callbacks are never run - so the same work runs inline.
BOOTED = defined?(Rails) && Rails.respond_to?(:application) && !Rails.application.nil?

def kit_say(message)
  say_status :kit, message, :green
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
  gem "dcb_event_store", github: "Kjeldahl/ruby-dcb" unless kit_gem?("dcb_event_store")
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
  # Each slice's views/ is a view-lookup root, so
  # app/slices/wallet/views/wallets/show.html.erb is found as "wallets/show".
  config.paths["app/views"].concat(root.glob("app/slices/*/views").map(&:to_s))

  # Set once, here, because config/ is off-limits to the slice agents: a
  # business rule that needs a local calendar notion (a business day, a
  # cutoff hour) is theirs to raise, not to guess. Domain code uses
  # Time.current and stores iso8601 in UTC.
  config.time_zone = ENV.fetch("APP_TIME_ZONE", "UTC")
WIRING

CONTROLLER_POLICY = <<~'POLICY'.freeze
  # Slice controllers are namespaced (Wallet::WalletsController) but their
  # templates live at app/slices/<slice>/views/<resource>/ - without the
  # namespace segment. Rails' default lookup prefix is the full controller
  # path ("wallet/wallets"), which finds nothing and renders 204 No Content;
  # the last segment is the one that matches. Resource directory names must
  # therefore be unique across slices - they share one lookup path.
  def self.local_prefixes
    [ controller_path.split("/").last ]
  end

  # The JSON API is stateless and token-less (see each slice's web/openapi.rb),
  # so a `curl -d '{...}'` call carries no CSRF token and would be rejected
  # with 422. HTML form posts keep full forgery protection.
  protect_from_forgery with: :exception, unless: -> { request.format.json? }
POLICY

# module: :wallet is required - the controller is Wallet::WalletsController.
# Without it Rails looks up a top-level WalletsController and raises
# "uninitialized constant WalletsController".
KIT_ROUTES = <<~'ROUTES'.freeze
  get "openapi.json" => "openapi#show"

  resources :wallets, only: :show, param: :wallet_id, module: :wallet do
    member do
      post :deposit
      post :withdraw
    end
  end
ROUTES

def kit_patch_app!
  unless File.read("config/application.rb").include?("app.collapse_slice_dirs")
    inject_into_class "config/application.rb", "Application", SLICES_WIRING.indent(4)
  end

  unless File.read("app/controllers/application_controller.rb").include?("local_prefixes")
    inject_into_class "app/controllers/application_controller.rb",
                      "ApplicationController", CONTROLLER_POLICY.indent(2)
  end

  route KIT_ROUTES unless File.read("config/routes.rb").include?("openapi#show")
end

# config/event_store.yml ships with "my_app" in it, because the overlay is
# copied, never rendered. Unanchored on purpose: the PostgreSQL database
# names are my_app_development / _test / _production, and a \b before the
# underscore would leave every one of them behind — the switch to PostgreSQL
# would then silently target someone else's database name.
def kit_name_the_app!
  gsub_file "config/event_store.yml", "my_app", app_name, verbose: false
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

def kit_finish!
  kit_rspec!
  kit_archive_example!
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
  run "bundle install"
  kit_finish!
else
  after_bundle { kit_finish! }
end

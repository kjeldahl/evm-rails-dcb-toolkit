# frozen_string_literal: true

# Packwerk extension, loaded via the `require` list in packwerk.yml (it must
# stay out of the app's autoload paths — the packwerk gem isn't loaded at app
# runtime).
#
# Packwerk builds its constant map from the Zeitwerk *root* directories
# (Rails.autoloaders ... loader.dirs), but app/slices/*/{domain,web} are
# Zeitwerk-collapsed (config/application.rb): wallet/domain/deposit.rb
# defines Wallet::Deposit, not Wallet::Domain::Deposit. Collapsed dirs are
# not root dirs, so without this patch every slice constant is unresolvable
# and packwerk silently ignores all references to them — i.e. the slice
# boundaries this gate exists to enforce would go unchecked. Verify the gate
# stays alive after a packwerk upgrade: add a cross-slice reference and
# confirm `packwerk check` fails.
#
# The fix: also register each collapsed dir as a load path rooted in its
# slice's namespace, which mirrors what the collapse means to Zeitwerk.
module PackwerkCollapsedSliceDirs
  private

  def extract_application_autoload_paths
    collapsed = Rails.root.glob("app/slices/*/{domain,web}").to_h do |dir|
      [ dir.to_s, dir.parent.basename.to_s.camelize.constantize ]
    end
    super.merge(collapsed)
  end
end

Packwerk::RailsLoadPaths.singleton_class.prepend(PackwerkCollapsedSliceDirs)

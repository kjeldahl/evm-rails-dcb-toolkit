# frozen_string_literal: true

namespace :quality do
  desc "Run packwerk (slice boundary check: no cross-slice constant refs)"
  task :packwerk do
    sh "bundle exec packwerk check"
  end
end

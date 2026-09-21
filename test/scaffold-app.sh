#!/bin/sh
# Scaffolds a Rails app with this kit installed, for test/e2e-rails.test.cjs:
# `rails new` (the flags from INSTALL.md), the root overlay from this checkout
# (not a clone of main — the test must see the working tree), .build-kit/,
# then template.rb from this checkout. Needs Ruby >= 3.3 and the rails gem.
#
#   test/scaffold-app.sh /tmp/kit-e2e-app
#   KIT_E2E_APP=/tmp/kit-e2e-app npm test
set -eu

target=${1:?usage: scaffold-app.sh <target-dir>}
kit=$(cd "$(dirname "$0")/.." && pwd)

rm -rf "$target"
rails new "$target" --skip-active-record --skip-action-mailbox --skip-action-text \
  --skip-active-storage --skip-test --skip-system-test --skip-git --skip-bundle
cd "$target"
cp -R "$kit/templates/root/." .
rm -rf .githooks                      # installed by the test, the way `init --hooks` does it
mkdir -p .build-kit
cp -R "$kit/templates/build-kit/." .build-kit/
bundle install --quiet
bin/rails app:template LOCATION="$kit/template.rb"

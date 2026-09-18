# frozen_string_literal: true

# Assembles the app's OpenAPI 3.1 document from slice-local contributions.
#
# Each slice that exposes HTTP endpoints ships app/slices/<context>/web/
# openapi.rb defining <Context>::Openapi with `.paths` (and optionally
# `.schemas` and `.webhooks`). Discovery happens at call time by file glob +
# constantize — no registry to keep in sync, no boot-order coupling, and no
# static cross-package constant reference for packwerk to flag: the root
# package never names a slice constant in code.
#
# Served at GET /openapi.json by OpenapiController.
module OpenApi
  extend self

  def document
    {
      openapi: "3.1.0",
      info: { title: Rails.application.class.module_parent_name, version: "1.0.0" },
      paths: merged(:paths),
      components: { schemas: merged(:schemas) },
      webhooks: merged(:webhooks)
    }
  end

  def contributors
    Rails.root.glob("app/slices/*/web/openapi.rb").sort.map do |file|
      "#{file.dirname.parent.basename.to_s.camelize}::Openapi".constantize
    end
  end

  private

  def merged(section)
    contributors
      .select { |contributor| contributor.respond_to?(section) }
      .map(&section)
      .reduce({}, :merge)
  end
end

# frozen_string_literal: true

require "rails_helper"

# Guards INSTALL.md step 4 — the two lines pasted into ApplicationController
# that every slice depends on and nothing else enforces. Skip the paste and
# both failures are invisible to a green suite: a namespaced controller's
# template is never found (Rails renders 204 No Content rather than raising),
# and every JSON API call is rejected with 422.
#
# Slice-free on purpose: it must keep passing after the wallet worked example
# is deleted.
RSpec.describe ApplicationController do
  describe ".local_prefixes" do
    it "drops the slice namespace, so templates live at views/<resource>/" do
      slice_controller = Class.new(described_class) do
        def self.controller_path
          "wallet/wallets"
        end
      end

      expect(slice_controller.local_prefixes).to eq([ "wallets" ])
    end

    it "leaves a root-package controller alone" do
      root_controller = Class.new(described_class) do
        def self.controller_path
          "openapi"
        end
      end

      expect(root_controller.local_prefixes).to eq([ "openapi" ])
    end
  end

  describe "forgery protection", type: :controller do
    controller do
      def create
        render json: { ok: true }
      end
    end

    # The test environment turns forgery protection off wholesale, which is
    # exactly what this example needs back on.
    around do |example|
      original = ActionController::Base.allow_forgery_protection
      ActionController::Base.allow_forgery_protection = true
      example.run
      ActionController::Base.allow_forgery_protection = original
    end

    it "skips the CSRF check for the token-less JSON API" do
      post :create, format: :json

      expect(response).to have_http_status(:ok)
    end

    it "keeps it for HTML form posts" do
      expect { post :create }.to raise_error(ActionController::InvalidAuthenticityToken)
    end
  end
end

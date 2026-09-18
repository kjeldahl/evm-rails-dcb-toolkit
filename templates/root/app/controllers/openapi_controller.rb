# Root-package web infrastructure: serves the assembled OpenAPI document
# (lib/open_api.rb). Route: get "openapi.json" => "openapi#show".
class OpenapiController < ApplicationController
  def show
    render json: OpenApi.document
  end
end

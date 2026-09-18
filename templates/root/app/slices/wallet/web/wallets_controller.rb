# Thin by contract (.build-kit/CLAUDE.md): parse params, call one command
# or one reader, branch on Result, render. No folding beyond the reader, no
# invariant checks, no event construction here. Serves both the ERB screen
# and the JSON API documented in web/openapi.rb.
module Wallet
  class WalletsController < ApplicationController
    def show
      @wallet_id = params[:wallet_id]
      @balance_cents = Balance.find(wallet_id: @wallet_id)
      respond_to do |format|
        format.html
        format.json { render json: balance_body(@wallet_id) }
      end
    end

    def deposit
      respond_with Deposit.call(wallet_id: params[:wallet_id], amount_cents: params[:amount_cents])
    end

    def withdraw
      respond_with Withdraw.call(wallet_id: params[:wallet_id], amount_cents: params[:amount_cents])
    end

    private

    def respond_with(result)
      respond_to do |format|
        format.html { html_response(result) }
        format.json { json_response(result) }
      end
    end

    def html_response(result)
      if result.success?
        redirect_to wallet_path(result.value)
      else
        redirect_to wallet_path(params[:wallet_id]), alert: result.error
      end
    end

    # Status codes and body shapes match web/openapi.rb — keep them in sync.
    def json_response(result)
      if result.success?
        render json: balance_body(result.value)
      else
        render json: { error: result.error }, status: :unprocessable_entity
      end
    end

    def balance_body(wallet_id)
      { wallet_id:, balance_cents: Balance.find(wallet_id:) }
    end
  end
end

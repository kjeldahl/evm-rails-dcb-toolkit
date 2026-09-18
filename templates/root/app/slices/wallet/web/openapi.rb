# The wallet context's contribution to the app-wide OpenAPI document
# (lib/open_api.rb discovers this module by its file path). Documents
# exactly the routes this slice's controller serves and the fields its
# commands accept — the same names the board uses, nothing invented.
module Wallet
  module Openapi
    extend self

    def paths
      {
        "/wallets/{wallet_id}" => {
          "get" => {
            "operationId" => "getWalletBalance",
            "summary" => "Current balance of a wallet",
            "parameters" => [ wallet_id_parameter ],
            "responses" => {
              "200" => json_response("Folded balance (0 for an untouched wallet)",
                                     ref: "WalletBalance")
            }
          }
        },
        "/wallets/{wallet_id}/history" => {
          "get" => {
            "operationId" => "getWalletHistory",
            "summary" => "Ledger of one wallet's deposits and withdrawals, oldest first",
            "parameters" => [ wallet_id_parameter ],
            "responses" => {
              "200" => json_response("Folded ledger (empty for an untouched wallet)",
                                     ref: "WalletHistory")
            }
          }
        },
        "/wallets/{wallet_id}/deposit" => command_path("deposit", "Deposit into a wallet"),
        "/wallets/{wallet_id}/withdraw" => command_path("withdraw", "Withdraw from a wallet")
      }
    end

    def schemas
      {
        "WalletBalance" => {
          "type" => "object",
          "required" => %w[wallet_id balance_cents],
          "properties" => {
            "wallet_id" => { "type" => "string" },
            "balance_cents" => { "type" => "integer" }
          }
        },
        "WalletHistory" => {
          "type" => "object",
          "required" => %w[wallet_id entries],
          "properties" => {
            "wallet_id" => { "type" => "string" },
            "entries" => { "type" => "array", "items" => ref("WalletHistoryEntry") }
          }
        },
        "WalletHistoryEntry" => {
          "type" => "object",
          "required" => %w[kind amount_cents balance_cents at],
          "properties" => {
            "kind" => { "type" => "string", "enum" => %w[Deposit Withdrawal] },
            # Signed: a withdrawal is negative, so the running balance is a sum.
            "amount_cents" => { "type" => "integer" },
            "balance_cents" => { "type" => "integer" },
            "at" => { "type" => "string", "format" => "date-time" }
          }
        },
        "AmountCents" => {
          "type" => "object",
          "required" => %w[amount_cents],
          "properties" => {
            "amount_cents" => { "type" => "integer", "minimum" => 1 }
          }
        },
        "CommandRejected" => {
          "type" => "object",
          "required" => %w[error],
          "properties" => {
            # The board's rejection messages, verbatim — see the command specs.
            "error" => { "type" => "string" }
          }
        }
      }
    end

    private

    def command_path(operation, summary)
      {
        "post" => {
          "operationId" => "#{operation}Wallet",
          "summary" => summary,
          "parameters" => [ wallet_id_parameter ],
          "requestBody" => {
            "required" => true,
            "content" => { "application/json" => { "schema" => ref("AmountCents") } }
          },
          "responses" => {
            "200" => json_response("Accepted", ref: "WalletBalance"),
            "422" => json_response("Rejected by a domain rule", ref: "CommandRejected")
          }
        }
      }
    end

    def wallet_id_parameter
      {
        "name" => "wallet_id", "in" => "path", "required" => true,
        "schema" => { "type" => "string" }
      }
    end

    def json_response(description, ref:)
      {
        "description" => description,
        "content" => { "application/json" => { "schema" => ref(ref) } }
      }
    end

    def ref(name)
      { "$ref" => "#/components/schemas/#{name}" }
    end
  end
end

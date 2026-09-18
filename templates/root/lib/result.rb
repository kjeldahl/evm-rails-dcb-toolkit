# frozen_string_literal: true

# Shared result object returned by every slice command's `.call`.
# See .build-kit/CLAUDE.md ("Architecture rules").
#
#   Result.success(wallet_id)            #=> success? true, value wallet_id
#   Result.failure("wallet is overdrawn") #=> failure? true, error message
Result = Data.define(:success, :value, :error) do
  def self.success(value = nil)
    new(success: true, value: value, error: nil)
  end

  def self.failure(error)
    new(success: false, value: nil, error: error)
  end

  def success? = success
  def failure? = !success
end

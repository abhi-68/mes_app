-- Backstop constraints for IMPL-SPEC rev 3 invariants.
-- Application guards fire first; these exist so a code path that forgets one
-- fails loudly rather than corrupting the ledger.

ALTER TABLE inventory_balances DROP CONSTRAINT IF EXISTS chk_on_hand_non_negative;
ALTER TABLE inventory_balances
  ADD CONSTRAINT chk_on_hand_non_negative CHECK (on_hand >= 0);

ALTER TABLE inventory_balances DROP CONSTRAINT IF EXISTS chk_reserved_non_negative;
ALTER TABLE inventory_balances
  ADD CONSTRAINT chk_reserved_non_negative CHECK (active_reserved >= 0);

-- Invariant 5: reservations can never exceed what physically exists.
ALTER TABLE inventory_balances DROP CONSTRAINT IF EXISTS chk_reserved_within_on_hand;
ALTER TABLE inventory_balances
  ADD CONSTRAINT chk_reserved_within_on_hand CHECK (active_reserved <= on_hand);

ALTER TABLE reservations DROP CONSTRAINT IF EXISTS chk_reservation_non_negative;
ALTER TABLE reservations
  ADD CONSTRAINT chk_reservation_non_negative CHECK (outstanding_qty >= 0);

ALTER TABLE material_requirements DROP CONSTRAINT IF EXISTS chk_requirement_non_negative;
ALTER TABLE material_requirements
  ADD CONSTRAINT chk_requirement_non_negative CHECK (
    required_qty >= 0 AND issued_qty >= 0 AND returned_qty >= 0 AND scrapped_from_wip_qty >= 0
  );

-- rev 4: held stock is not available, and reserved + held cannot exceed what exists.
ALTER TABLE inventory_balances DROP CONSTRAINT IF EXISTS chk_reserved_within_on_hand;
ALTER TABLE inventory_balances DROP CONSTRAINT IF EXISTS chk_held_non_negative;
ALTER TABLE inventory_balances
  ADD CONSTRAINT chk_held_non_negative CHECK (held_qty >= 0);
ALTER TABLE inventory_balances DROP CONSTRAINT IF EXISTS chk_reserved_plus_held_within_on_hand;
ALTER TABLE inventory_balances
  ADD CONSTRAINT chk_reserved_plus_held_within_on_hand
  CHECK (active_reserved + held_qty <= on_hand);

-- Axis B invariant 3, on CURRENT quantities.
ALTER TABLE operation_outputs DROP CONSTRAINT IF EXISTS chk_output_commitments_within_accepted;
ALTER TABLE operation_outputs
  ADD CONSTRAINT chk_output_commitments_within_accepted
  CHECK (allocated_outstanding + issued_to_parent_outstanding <= accepted);

-- Axis A invariant 1.
ALTER TABLE operation_outputs DROP CONSTRAINT IF EXISTS chk_dispositions_sum_to_produced;
ALTER TABLE operation_outputs
  ADD CONSTRAINT chk_dispositions_sum_to_produced
  CHECK (pending_inspection + accepted + awaiting_rework + scrapped = produced);

-- A delivery note for nothing, or for a negative quantity, is not a record of
-- anything. The remaining-quantity rule lives in the command, because it needs
-- the other notes on the same order; this is the floor under it.
ALTER TABLE delivery_notes DROP CONSTRAINT IF EXISTS chk_delivery_quantity_positive;
ALTER TABLE delivery_notes
  ADD CONSTRAINT chk_delivery_quantity_positive CHECK (quantity > 0);

/**
 * Auto-centring shim for highway via members.
 *
 * Runs after `assignSlots` and before `routeChannels`. For each via
 * source/target, computes the median pixel mismatch between its slot
 * cluster and the highway's matching slot cluster, then stores a
 * sub-cell `pixelShift` on the placement so the slots align.
 *
 * The slot allocator centres each face's cluster independently. When
 * `(faceLen - traceCount)` has different parity between a member's
 * face-toward-hwy and the highway's matching face, every paired slot
 * lands 4 px off-grid. On members that share a row/col with the
 * highway, that off-grid bias renders as a visible C-curve kink on
 * every trace. On members that L-bend to the highway it shows as a
 * tiny chamfer at each end. Either way, aligning is free of visual
 * cost — the shift is sub-cell, so no other geometry moves with it.
 *
 * Mechanism:
 *   1. For each via-half edge from a member to its highway (or vice
 *      versa), compute Δy (or Δx for TB highways) = (hwy slot pixel) −
 *      (member slot pixel) on the perp axis.
 *   2. Take the median Δ.
 *   3. The integer-cell part of Δ is what the placer already produced;
 *      the SUB-CELL residual is the shim:
 *        `shim = medianΔ − round(medianΔ / 8) * 8`
 *      → range (−4, 4], with 0 meaning already aligned.
 *   4. If the member already carries a `pixelShift` from an author
 *      `offset:`, leave it alone — manual wins.
 *
 * For LR highways the shift goes on dy; for TB highways on dx.
 *
 * This is Option 2 of the half-cell slot misalignment fix. Option 1 is
 * the per-node `offset:` attribute (feedback-per-node-offset) — manual
 * override that lets the author dial in a specific shift. Option 2
 * picks up the obvious cases automatically; `offset:` remains the
 * escape hatch when the heuristic doesn't fit.
 */
import type { Model } from "../bind/model.js";
import type { Placement } from "./placement.js";
import { computePixelLayout, slotPixel } from "./pixels.js";
import type { SlotAssignment } from "./slots.js";

/**
 * Mutate `placement.pixelShift` to add half-cell shims that align each
 * via member's slot cluster with the highway's slot cluster on the
 * matching face. No-op for diagrams with no highway-via constructs.
 */
export function autoAlignViaShims(
  model: Model,
  placement: Placement,
  slots: Map<number, SlotAssignment>,
): void {
  if (model.highwayMemberships.length === 0) return;
  const layout = computePixelLayout(placement);
  const sizeOf = new Map(model.nodes.map((n) => [n.id, n.size]));

  // Pair via-halves by their original-edge index. The "via member" is
  // the source of the first half (= edge.from) and the target of the
  // second half (= edge.to). The HIGHWAY is the other endpoint on each.
  type Half = { edgeIndex: number; firstHalf: boolean };
  const halvesByOriginal = new Map<number, Half[]>();
  for (let i = 0; i < model.edges.length; i++) {
    const e = model.edges[i]!;
    if (e.source !== "via-half" || e.viaOriginal === undefined) continue;
    const arr = halvesByOriginal.get(e.viaOriginal) ?? [];
    arr.push({ edgeIndex: i, firstHalf: !!e.viaFirstHalf });
    halvesByOriginal.set(e.viaOriginal, arr);
  }

  for (const m of model.highwayMemberships) {
    const hwyCell = placement.cells.get(m.name);
    if (!hwyCell) continue;
    const hwySz = sizeOf.get(m.name) ?? { width: 1, height: 1 };
    const hwyW = Math.ceil(hwySz.width);
    const hwyH = Math.ceil(hwySz.height);

    // Direction of the perp axis to shift on. For a horizontal highway
    // (LR layout default, or `orient: horizontal`) the perp axis is y.
    // For a vertical highway it's x.
    const hwyFwd = placement.forwardAt.get(m.name) ?? "E";
    const perpAxis: "y" | "x" = hwyFwd === "E" || hwyFwd === "W" ? "y" : "x";

    const memberIds: string[] = [...m.sources, ...m.targets];
    for (const memberId of memberIds) {
      // Manual `offset:` wins. Author has already dialled in a shift.
      if (placement.pixelShift.has(memberId)) continue;
      const memberCell = placement.cells.get(memberId);
      if (!memberCell) continue;
      const memberSz = sizeOf.get(memberId) ?? { width: 1, height: 1 };
      const memberW = Math.ceil(memberSz.width);
      const memberH = Math.ceil(memberSz.height);

      const deltas: number[] = [];
      for (let i = 0; i < model.edges.length; i++) {
        const e = model.edges[i]!;
        if (e.source !== "via-half") continue;
        // First-half: member is `from`, hwy is `to`. Second-half: member
        // is `from` and hwy is the upstream `from` of the other half —
        // for a via-source, only the first half pairs us with the hwy on
        // its target face. For a via-target, only the second half.
        let memberOnFrom: boolean;
        if (e.from === memberId && e.to === m.name) memberOnFrom = true;
        else if (e.from === m.name && e.to === memberId) memberOnFrom = false;
        else continue;
        const slot = slots.get(i);
        if (!slot) continue;
        const memberSide = memberOnFrom ? slot.sourceSide : slot.targetSide;
        const memberSlot = memberOnFrom ? slot.sourceSlot : slot.targetSlot;
        const hwySide = memberOnFrom ? slot.targetSide : slot.sourceSide;
        const hwySlot = memberOnFrom ? slot.targetSlot : slot.sourceSlot;
        const memberPx = slotPixel(
          memberSide, memberSlot, memberCell, memberW, memberH, layout,
        );
        const hwyPx = slotPixel(
          hwySide, hwySlot, hwyCell, hwyW, hwyH, layout,
        );
        const delta = perpAxis === "y" ? hwyPx.y - memberPx.y : hwyPx.x - memberPx.x;
        deltas.push(delta);
      }
      if (deltas.length === 0) continue;
      const medianDelta = median(deltas);
      // Sub-cell residual after truncating to whole cells (toward zero,
      // NOT to-nearest). Range [−4, 4]: 0 means already aligned; ±4
      // means half-cell off. Truncating-toward-zero keeps the shim
      // sign matched to medianDelta's sign — `shim = medianDelta`
      // straightens the trace, while `shim = −medianDelta` would shift
      // src/tgt to an ADJACENT hwy slot, leaving the trace bent. The
      // placer is responsible for whole-cell offsets; we only fix the
      // sub-cell residual.
      const rounded = Math.trunc(medianDelta / 8) * 8;
      const shim = medianDelta - rounded;
      if (Math.abs(shim) < 0.5) continue; // already aligned within rounding noise
      const dx = perpAxis === "x" ? shim : 0;
      const dy = perpAxis === "y" ? shim : 0;
      placement.pixelShift.set(memberId, { dx, dy });
    }
  }
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return sorted[(n - 1) / 2]!;
  return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

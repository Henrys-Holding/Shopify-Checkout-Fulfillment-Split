// app/utils.server.js

const dollarsToCents = (val) => Math.round(val * 100);
const toCents = (val) => Math.round(parseFloat(val) * 100);

/**
 * Returns an array of Parcels.
 * Each Parcel is an array of items: { lineIndex: number, quantity: number }
 */
export function calculateFulfillmentSplits(lines, opts = {}) {
    const capCents = dollarsToCents(opts.cap ?? 270);
    const absorbPerHeavyCents = dollarsToCents(opts.absorbPerHeavy ?? 60);
    const absorbItemsPerHeavy = opts.absorbItemsPerHeavy ?? 2;

    // 1. Explode Lines into Individual Units
    // We track { price, originalLineIndex } for every single unit.
    let allUnits = [];

    lines.forEach((line, index) => {
        if (!line || !line.cost || !line.cost.totalAmount) return;

        const quantity = (line.quantity | 0);
        const totalAmt = line.cost.totalAmount.amount;
        const totalCents = toCents(totalAmt);

        if (quantity <= 0) return;

        // Distribute price evenly across units
        const base = Math.floor(totalCents / quantity);
        const remainder = totalCents - base * quantity;

        for (let i = 0; i < quantity; i++) {
            // The first 'remainder' items get (base + 1), the rest get base
            const price = i < remainder ? base + 1 : base;
            allUnits.push({ price, lineIndex: index });
        }
    });

    // 2. Separate Zero-Price, Heavy, and Non-Heavy
    const zeroUnits = [];
    const heavyUnits = []; // Each heavy unit starts its own parcel
    const nonHeavyUnits = [];

    allUnits.forEach(u => {
        if (u.price <= 0) zeroUnits.push(u);
        else if (u.price > capCents) heavyUnits.push(u);
        else nonHeavyUnits.push(u);
    });

    // Initialize Parcels with Heavy Units (1 heavy unit per parcel)
    let parcels = heavyUnits.map(u => ({
        anchor: u,
        absorbed: [],
        residualCapacity: 0 // Heavy parcels don't take general residual, only specific absorption
    }));

    // 3. Absorption: Heavy parcels absorb cheap items
    // Sort non-heavy items cheapest first to maximize absorption count
    nonHeavyUnits.sort((a, b) => a.price - b.price);

    let residualUnits = [];

    // Clone nonHeavy to process
    let toAbsorb = [...nonHeavyUnits];

    parcels.forEach(parcel => {
        let budgetCents = absorbPerHeavyCents;
        let budgetItems = absorbItemsPerHeavy;

        // Filter items that fit this parcel's absorption budget
        // We iterate backwards to remove items we consume
        for (let i = 0; i < toAbsorb.length; i++) {
            const unit = toAbsorb[i];
            if (budgetItems > 0 && budgetCents >= unit.price) {
                // Absorb it
                parcel.absorbed.push(unit);
                budgetItems--;
                budgetCents -= unit.price;

                // Mark as null to remove later
                toAbsorb[i] = null;
            }
        }
        // Clean up nulls
        toAbsorb = toAbsorb.filter(u => u !== null);
    });

    residualUnits = toAbsorb;

    // 4. Bin Packing for Residuals (First-Fit Decreasing)
    residualUnits.sort((a, b) => b.price - a.price);

    // 'residualBins' will be an array of { capacity: number, items: unit[] }
    const residualBins = [];

    residualUnits.forEach(unit => {
        let placed = false;
        // Try to fit in existing bin
        for (let bin of residualBins) {
            if (bin.capacity >= unit.price) {
                bin.items.push(unit);
                bin.capacity -= unit.price;
                placed = true;
                break;
            }
        }
        // Else create new bin
        if (!placed) {
            residualBins.push({
                capacity: capCents - unit.price,
                items: [unit]
            });
        }
    });

    // 5. Consolidate Results into formatted output
    // We need to group identical line items within a parcel to be clean
    // Structure: [  [ { lineItemIndex: 0, quantity: 2 }, ... ], [ ... ]  ]

    const finalParcels = [];

    // Add Heavy Parcels (Anchor + Absorbed)
    parcels.forEach(p => {
        const units = [p.anchor, ...p.absorbed];
        finalParcels.push(consolidateUnits(units));
    });

    // Add Residual Bins
    residualBins.forEach(bin => {
        finalParcels.push(consolidateUnits(bin.items));
    });

    // Add Zero-price items (logic undefined? Let's put them in the first parcel or new one)
    // For safety, let's put them in the first parcel if exists, or a new one
    if (zeroUnits.length > 0) {
        if (finalParcels.length > 0) {
            const firstParcelUnits = expandParcel(finalParcels[0]);
            finalParcels[0] = consolidateUnits([...firstParcelUnits, ...zeroUnits]);
        } else {
            finalParcels.push(consolidateUnits(zeroUnits));
        }
    }

    return finalParcels;
}

// Helper: Turn a list of units [{lineIndex: 0}, {lineIndex: 0}] into [{lineIndex: 0, quantity: 2}]
function consolidateUnits(units) {
    const map = new Map();
    units.forEach(u => {
        const current = map.get(u.lineIndex) || 0;
        map.set(u.lineIndex, current + 1);
    });

    const result = [];
    map.forEach((qty, idx) => {
        result.push({ lineIndex: idx, quantity: qty });
    });
    return result;
}

// Helper: Reverse consolidate for the zero-unit edge case
function expandParcel(parcelItems) {
    let units = [];
    parcelItems.forEach(p => {
        for (let i = 0; i < p.quantity; i++) units.push({ lineIndex: p.lineIndex });
    });
    return units;
}
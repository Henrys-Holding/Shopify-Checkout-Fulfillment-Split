// app/utils.server.js

const dollarsToCents = (val) => Math.round(val * 100);
const toCents = (val) => Math.round(parseFloat(val) * 100);
/**
 * Returns an array of Parcels.
 * Each Parcel is an array of items:
 * { lineIndex: number, quantity: number, lineItemId: string|number, lineItemPrice: number }
 */
export function calculateFulfillmentSplits(lines, opts = {}) {
    const capCents = dollarsToCents(opts.cap ?? 270);
    const absorbPerHeavyCents = dollarsToCents(opts.absorbPerHeavy ?? 60);
    const absorbItemsPerHeavy = opts.absorbItemsPerHeavy ?? 2;

    // 1) Explode Lines into Individual Units
    // Track { price, lineIndex, lineItemId, lineItemPrice } for every single unit.
    const allUnits = [];

    lines.forEach((line, index) => {
        if (!line || line.price == null) return;

        const quantity = (line.quantity | 0);
        if (quantity <= 0) return;

        const totalAmt = line.price * quantity;
        const totalCents = toCents(totalAmt);

        // Distribute price evenly across units
        const base = Math.floor(totalCents / quantity);
        const remainder = totalCents - base * quantity;

        for (let i = 0; i < quantity; i++) {
            const price = i < remainder ? base + 1 : base;
            allUnits.push({
                price,
                lineIndex: index,
                lineItemId: line.admin_graphql_api_id,
                lineItemPrice: line.price
            });
        }
    });

    // 2) Separate Zero-Price, Heavy, and Non-Heavy
    const zeroUnits = [];
    const heavyUnits = [];
    const nonHeavyUnits = [];

    for (const u of allUnits) {
        if (u.price <= 0) zeroUnits.push(u);
        else if (u.price > capCents) heavyUnits.push(u);
        else nonHeavyUnits.push(u);
    }

    // Heavy parcels: 1 heavy unit per parcel
    const heavyParcels = heavyUnits.map(u => ({
        anchor: u,
        absorbed: []
    }));

    // 3) Absorption: Heavy parcels absorb cheap items
    // Sort cheapest first to maximize count absorbed
    nonHeavyUnits.sort((a, b) => a.price - b.price);
    let toAbsorb = [...nonHeavyUnits];

    for (const parcel of heavyParcels) {
        let budgetCents = absorbPerHeavyCents;
        let budgetItems = absorbItemsPerHeavy;

        for (let i = 0; i < toAbsorb.length; i++) {
            const unit = toAbsorb[i];
            if (!unit) continue;

            if (budgetItems > 0 && budgetCents >= unit.price) {
                parcel.absorbed.push(unit);
                budgetItems--;
                budgetCents -= unit.price;
                toAbsorb[i] = null;
            }
        }

        toAbsorb = toAbsorb.filter(u => u !== null);
    }

    const residualUnits = toAbsorb;

    // 4) Bin Packing for Residuals (First-Fit Decreasing)
    residualUnits.sort((a, b) => b.price - a.price);

    const residualBins = [];
    for (const unit of residualUnits) {
        let placed = false;

        for (const bin of residualBins) {
            if (bin.capacity >= unit.price) {
                bin.items.push(unit);
                bin.capacity -= unit.price;
                placed = true;
                break;
            }
        }

        if (!placed) {
            residualBins.push({
                capacity: capCents - unit.price,
                items: [unit]
            });
        }
    }

    // 5) Consolidate Results into formatted output
    const finalParcels = [];

    // Heavy parcels (anchor + absorbed)
    for (const p of heavyParcels) {
        finalParcels.push(consolidateUnits([p.anchor, ...p.absorbed]));
    }

    // Residual bins
    for (const bin of residualBins) {
        finalParcels.push(consolidateUnits(bin.items));
    }

    // Zero-price items: put into first parcel if possible, else new parcel
    if (zeroUnits.length > 0) {
        if (finalParcels.length > 0) {
            const firstParcelUnits = expandParcel(finalParcels[0], lines);
            finalParcels[0] = consolidateUnits([...firstParcelUnits, ...zeroUnits]);
        } else {
            finalParcels.push(consolidateUnits(zeroUnits));
        }
    }

    return finalParcels;
}

/**
 * Consolidate units into parcel line summary, INCLUDING lineItemId & lineItemPrice.
 * Safe behavior: groups by (lineIndex + lineItemId + lineItemPrice) so we never mix mismatched metadata.
 */
function consolidateUnits(units) {
    const map = new Map();
    for (const u of units) {
        // If you *guarantee* lineIndex uniquely maps to (id, price), you can key only by lineIndex.
        const key = `${u.lineIndex}::${String(u.lineItemId)}::${String(u.lineItemPrice)}`;

        const existing = map.get(key);
        if (existing) {
            existing.quantity += 1;
        } else {
            map.set(key, {
                lineIndex: u.lineIndex,
                quantity: 1,
                lineItemId: u.lineItemId,
                lineItemPrice: u.lineItemPrice
            });
        }
    }

    return Array.from(map.values());
}

/**
 * Expand a consolidated parcel back into per-unit objects with id/price metadata.
 * Requires `lines` so we can recover lineItemId/lineItemPrice if needed.
 */
function expandParcel(parcel, lines) {
    const units = [];
    for (const item of parcel) {
        const line = lines?.[item.lineIndex] ?? {};
        const lineItemId = item.lineItemId ?? line.id;
        const lineItemPrice = item.lineItemPrice ?? line.price;

        const qty = item.quantity | 0;
        for (let i = 0; i < qty; i++) {
            units.push({
                price: 0, // not needed for reconsolidation of zeroUnits; keep harmless default
                lineIndex: item.lineIndex,
                lineItemId,
                lineItemPrice
            });
        }
    }
    return units;
}


export function getParcelPriceByShippingLineTitle(title, countryCode) {
    if (!title || !countryCode) return null;

    if (title.includes('1档邮政') || title.includes('#1')) return countryCode === "CN" ? 25 : 38;
    if (title.includes('2档邮政') || title.includes('#2')) return countryCode === "CN" ? 25 : 38;
    if (title.includes('3档邮政') || title.includes('#3')) return countryCode === "CN" ? 38 : 38;
    if (title.includes('4档邮政') || title.includes('#4')) return countryCode === "CN" ? 15 : 38;
    if (title.includes('5档邮政') || title.includes('#5')) return countryCode === "CN" ? 38 : 38;
    return null;
}

export function getShippingLineLevel(title, countryCode) {
    if (!title || !countryCode) return null;
    if (title.includes('1档邮政') || title.includes('#1')) return countryCode === "CN" ? 1 : 2;
    if (title.includes('2档邮政') || title.includes('#2')) return countryCode === "CN" ? 2 : 2;
    if (title.includes('3档邮政') || title.includes('#3')) return countryCode === "CN" ? 3 : 2;
    if (title.includes('4档邮政') || title.includes('#4')) return countryCode === "CN" ? 4 : 2;
    if (title.includes('5档邮政') || title.includes('#5')) return countryCode === "CN" ? 5 : 2;
    return null;
}

export function getAttributeValueByName(attributes, name) {
    const attribute = attributes?.find(attr => attr.name === name);
    return attribute?.value || null;
}
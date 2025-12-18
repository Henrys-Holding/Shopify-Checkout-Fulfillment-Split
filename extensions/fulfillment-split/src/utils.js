// utils.js

// Missing helpers inferred from context
const dollarsToCents = (val) => Math.round(val * 100);
const toCents = (val) => Math.round(parseFloat(val) * 100);

export function recommendFulfillmentCount(lines, opts = {}) {
    // ---- config (all cents; convert dollars to cents safely) ----
    const capCents = dollarsToCents(opts.cap == null ? 270 : opts.cap);
    const absorbPerHeavyCents = dollarsToCents(
        opts.absorbPerHeavy == null ? 60 : opts.absorbPerHeavy,
    );
    const absorbItemsPerHeavy =
        opts.absorbItemsPerHeavy == null ? 2 : opts.absorbItemsPerHeavy;

    const unitTypes = [];
    let currency = null;
    let totalCents = 0;

    for (let i = 0; i < lines.length; i++) {
        const li = lines[i];
        if (!li || !li.cost || !li.cost.totalAmount) continue;

        const q = (li.quantity | 0) > 0 ? li.quantity | 0 : 0;
        const amt = li.cost.totalAmount.amount;
        const cur = li.cost.totalAmount.currencyCode || null;
        if (currency == null) currency = cur;

        const lineCents = toCents(amt);
        totalCents += lineCents;

        if (q <= 0) continue;

        // Split line total into q per-unit amounts
        const base = Math.floor(lineCents / q);
        let remainder = lineCents - base * q;

        if (remainder > 0) unitTypes.push([base + 1, remainder]);
        const rest = q - remainder;
        if (rest > 0) unitTypes.push([base, rest]);
    }

    // Move zero-priced items out early
    let zeroCount = 0;
    const nonZeroTypes = [];
    for (let i = 0; i < unitTypes.length; i++) {
        const [p, c] = unitTypes[i];
        if (p <= 0) zeroCount += c;
        else nonZeroTypes.push([p, c]);
    }

    // ---- split heavy vs non-heavy ----
    let heavyUnitCount = 0;
    const nonHeavyTypes = [];
    let nonHeavyUnitCount = 0;
    let nonHeavyTotalCents = 0;

    for (let i = 0; i < nonZeroTypes.length; i++) {
        const [p, c] = nonZeroTypes[i];
        if (p > capCents) {
            heavyUnitCount += c;
        } else {
            nonHeavyTypes.push([p, c]);
            nonHeavyUnitCount += c;
            nonHeavyTotalCents += p * c;
        }
    }

    // ---- special absorption ----
    let absorbCentsBudget = heavyUnitCount * absorbPerHeavyCents;
    let absorbItemsBudget = heavyUnitCount * absorbItemsPerHeavy;

    let heavyAbsorbedItems = 0;
    let heavyAbsorbedCents = 0;

    nonHeavyTypes.sort((a, b) => a[0] - b[0]);

    const residualTypes = [];
    for (let i = 0; i < nonHeavyTypes.length; i++) {
        const p = nonHeavyTypes[i][0];
        let c = nonHeavyTypes[i][1];

        if (absorbItemsBudget > 0 && absorbCentsBudget > 0) {
            const byCents = Math.floor(absorbCentsBudget / p);
            let take = byCents < c ? byCents : c;
            if (take > absorbItemsBudget) take = absorbItemsBudget;

            if (take > 0) {
                const takeCents = take * p;
                heavyAbsorbedItems += take;
                heavyAbsorbedCents += takeCents;
                absorbItemsBudget -= take;
                absorbCentsBudget -= takeCents;
                c -= take;
            }
        }

        if (c > 0) residualTypes.push([p, c]);
    }

    // ---- pack remaining non-heavy units ----
    residualTypes.sort((a, b) => b[0] - a[0]);

    const bins = [];

    for (let t = 0; t < residualTypes.length; t++) {
        const price = residualTypes[t][0];
        let count = residualTypes[t][1];

        for (let b = 0; b < bins.length && count > 0; b++) {
            const canFit = (bins[b] / price) | 0;
            if (canFit > 0) {
                const put = canFit < count ? canFit : count;
                bins[b] -= put * price;
                count -= put;
            }
        }

        if (count <= 0) continue;

        const perBin = (capCents / price) | 0;
        const fullBins = (count / perBin) | 0;
        const remItems = count - fullBins * perBin;

        for (let k = 0; k < fullBins; k++) {
            bins.push(capCents - perBin * price);
        }
        if (remItems > 0) {
            bins.push(capCents - remItems * price);
        }
    }

    const additionalParcels = bins.length;
    const fulfillmentCount = heavyUnitCount + additionalParcels;

    return { fulfillmentCount };
}
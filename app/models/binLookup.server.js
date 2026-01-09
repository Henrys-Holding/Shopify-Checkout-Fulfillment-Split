import { binLookup } from "@arnabxd/bin-lookup";
import lookup from "binlookup";

export async function fetchBinInfo(binNumber) {
    let lookupResponse = await binLookup(binNumber);

    const { result, data } = lookupResponse;

    if (!result) {
        // using callbacks
        lookupResponse = await lookup(binNumber);

        if (!lookupResponse) {
            return null;
        }

        if (!lookupResponse?.bank?.name) return null;

        if (lookupResponse) {
            const binData = {
                bin: binNumber,
                scheme: lookupResponse?.scheme,
                type: lookupResponse?.type,
                bank: lookupResponse?.bank?.name,
                country: lookupResponse?.country?.name,
                country_code: lookupResponse?.country?.alpha2,
            };

            return binData;
        }
    }

    const binData = {
        bin: data?.bin,
        scheme: data?.vendor,
        type: data?.type,
        bank: data?.bank,
        country: data?.countryInfo?.name,
        country_code: data?.countryInfo?.code,
    };
    return binData;
}

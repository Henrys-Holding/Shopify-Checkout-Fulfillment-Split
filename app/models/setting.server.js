import db from "../db.server.js";

export async function getSetting(shop) {
    let setting;
    setting = await db.creditCardVerificationSetting.findFirst({
        where: {
            shop,
            enabled: true, 
            auto_change_order_status: true
        },
    })

    if (!setting) {
        setting = await db.creditCardVerificationSetting.create({
            data: {
                shop,
                enabled: true,
                auto_change_order_status: true
            }
        })
    }

    return setting;
}
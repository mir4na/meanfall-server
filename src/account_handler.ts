const OTP_EXPIRY_MS = 300000;

export function rpcSendOtp(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const input = JSON.parse(payload);
    const email = input.email;

    if (!email) {
        throw new Error("Email is required");
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = Date.now() + OTP_EXPIRY_MS;

    const storageWrite: nkruntime.StorageWriteRequest = {
        collection: "otps",
        key: email,
        userId: "00000000-0000-0000-0000-000000000000",
        value: { otp: otp, expiry: expiry },
        permissionRead: 0,
        permissionWrite: 0,
    };

    nk.storageWrite([storageWrite]);

    logger.info("OTP for %s: %s", email, otp);

    const mailerUrl = "http://mailer:3000/send";
    const mailerHeaders = { "Content-Type": "application/json" };
    const mailerBody = JSON.stringify({ to: email, otp: otp });

    try {
        nk.httpRequest(mailerUrl, "post", mailerHeaders, mailerBody);
    } catch (e: any) {
        // We log the error but don't block the client from proceeding,
        // in case the mail service is down but they can read the OTP from logs.
        logger.error("Failed to contact mailer service: %s", e.message);
    }

    return JSON.stringify({ success: true });
}

export function rpcVerifyOtp(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const input = JSON.parse(payload);
    const email = input.email;
    const otp = input.otp;

    if (!email || !otp) {
        throw new Error("Email and OTP are required");
    }

    const storageRead: nkruntime.StorageReadRequest = {
        collection: "otps",
        key: email,
        userId: "00000000-0000-0000-0000-000000000000",
    };

    const results = nk.storageRead([storageRead]);
    if (results.length === 0) {
        throw new Error("OTP expired or not found");
    }

    const data = results[0].value;
    if (Date.now() > data.expiry) {
        throw new Error("OTP expired");
    }

    if (data.otp !== otp) {
        throw new Error("Invalid OTP");
    }

    return JSON.stringify({ success: true });
}

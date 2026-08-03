const path = require("path");

require("dotenv").config({
    path: path.join(__dirname, ".env")
});


function get(name, required = true, defaultValue = null) {
    const value = process.env[name];

    if ((value === undefined || value === "") && required) {
        throw new Error(`Missing environment variable: ${name}`);
    }

    return value ?? defaultValue;
}

const config = {

    server: {
        host: get("HOST", false, "0.0.0.0"),
        port: Number(get("PORT", false, "4000")),
        env: get("NODE_ENV", false, "development")
    },

    angel: {

        enabled: get("ANGEL_ENABLED", false, "true") === "true",

        apiKey: get("ANGEL_API_KEY"),

        clientCode: get("ANGEL_CLIENT_CODE"),

        password: get("ANGEL_PASSWORD"),

        totpSecret: get("ANGEL_TOTP_SECRET"),

        baseUrl: get(
            "ANGEL_BASE_URL",
            false,
            "https://apiconnect.angelone.in"
        )

    },

    groww: {

        enabled: get("GROWW_ENABLED", false, "true") === "true",

        apiKey: get("GROWW_TOTP_TOKEN"),

        apiSecret: get("GROWW_TOTP_SECRET"),

       

        baseUrl: get(
            "GROWW_BASE_URL",
            false,
            "https://api.groww.in"
        )

    }

};

module.exports = config;
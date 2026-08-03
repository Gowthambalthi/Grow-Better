"use strict";

const crypto = require("crypto");
const nkeys = require("ts-nkeys");
const login = require("./login");

// Verified against growwapi (official Python SDK) v1.5.0 source, client.py:
//   self.domain = "https://api.groww.in/v1"
//   _GROWW_GENERATE_SOCKET_TOKEN_URL = f"{domain}/api/apex/v1/socket/token/create/"
// NOTE the trailing slash and the /v1 root segment. Both are required or the
// gateway returns 404. This is intentionally NOT derived from config.groww.baseUrl,
// since that value is used elsewhere for the non-versioned root and mixing the two
// is exactly how the previous 404 happened.
const SOCKET_TOKEN_URL =
    "https://api.groww.in/v1/api/apex/v1/socket/token/create/";

const CLIENT_PLATFORM_VERSION = "1.5.0";
const API_VERSION = "1.0";

function buildHeaders(token) {

    return {
        "x-request-id": crypto.randomUUID(),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-client-id": "growwapi",
        "x-client-platform": "growwapi-node-client",
        "x-client-platform-version": CLIENT_PLATFORM_VERSION,
        "x-api-version": API_VERSION
    };

}

async function createSocketCredentials() {

    console.log("=================================");
    console.log("Groww Socket Authentication");
    console.log("=================================");

    console.log("Logging in...");

    const auth = await login.login();

    if (!auth || !auth.token) {
        throw new Error("Groww login failed.");
    }

    console.log("Login Successful.");

    console.log("Generating NATS KeyPair...");

    const keyPair = nkeys.createUser();

    const publicKey = keyPair.getPublicKey().toString("utf8");
    const seed = keyPair.getSeed();

    if (!publicKey || !seed) {
        throw new Error("Unable to generate NATS credentials.");
    }

    console.log("Requesting Socket Token...");
    console.log("Socket URL:", SOCKET_TOKEN_URL);

    const response = await fetch(SOCKET_TOKEN_URL, {
        method: "POST",
        headers: buildHeaders(auth.token),
        body: JSON.stringify({
            socketKey: publicKey
        })
    });

    if (!response.ok) {

        const error = await response.text().catch(() => "");

        throw new Error(
`Socket Authentication Failed

HTTP : ${response.status}

${error}`
        );
    }

    const json = await response.json();

    if (!json.token || !json.subscriptionId) {
        throw new Error("Invalid socket authentication response.");
    }

    console.log("Socket Token Received.");
    console.log("Subscription ID:", json.subscriptionId);

    if (json.expiry) {
        console.log("Expiry:", json.expiry);
    }

    return {
        token: json.token,
        subscriptionId: json.subscriptionId,
        expiry: json.expiry,
        seed
    };
}

module.exports = {
    createSocketCredentials
};